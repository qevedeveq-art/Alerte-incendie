// =====================================================================
//  dispatch — vidage de la file d'alertes vers les appareils
// ---------------------------------------------------------------------
//    Web Push : VAPID + chiffrement aes128gcm (jsr:@negrel/webpush)
//
//  Corrections de fiabilite conservées :
//
//  1. REPRISE REELLE. On ecrivait `tentatives = 4` des le premier echec
//     alors que la selection filtrait sur `tentatives < 4` : l'alerte
//     n'etait jamais rejouee et restait 'en_attente' pour toujours. Le
//     compteur est desormais incremente d'une unite, avec temporisation
//     croissante, et la peremption est geree en base (alertes_a_envoyer).
//
//  2. ENVOIS CONCURRENTS des appels Web Push indépendants, par vagues
//     bornées pour éviter de saturer la fonction.
//
//  Idempotent : une alerte deja « envoye » n'est jamais rejouee, grace
//  a l'index unique (evenement, canal, severite, type). Un canal qui
//  echoue 5 fois, ou dont l'abonnement push est revoque (404/410), est
//  desactive automatiquement et signale dans l'interface.
// =====================================================================
import {
  autoriserOperation,
  config,
  configVersion,
  CORS,
  fermerRun,
  json,
  ouvrirRun,
  sb,
} from "../_shared/mod.ts";
import { corpsFinTexte, corpsTexte, type Payload, titre, titreFin } from "./messages.ts";
import * as webpush from "jsr:@negrel/webpush@^0.3";

const MAX_ECHECS = 5;
const MAX_TENTATIVES = 5;
const CONCURRENCE = 8;

// ---------------------------------------------------------------------
//  Serveur Web Push, mis en cache mais invalide si la configuration
//  change : sans cela, une rotation des cles VAPID exigeait un
//  redeploiement, ce que la table config est justement censee eviter.
// ---------------------------------------------------------------------
let serveurPush: webpush.ApplicationServer | null = null;
let versionPush = -1;

async function appPush(cfg: Record<string, any>) {
  if (serveurPush && versionPush === configVersion) return serveurPush;
  if (!cfg.vapid_jwk) throw new Error("vapid_jwk absent de la configuration");
  serveurPush = await webpush.ApplicationServer.new({
    contactInformation: String(cfg.vapid_subject ?? "mailto:admin@localhost"),
    vapidKeys: await webpush.importVapidKeys(cfg.vapid_jwk, { extractable: false }),
  });
  versionPush = configVersion;
  return serveurPush;
}

/** Titre et corps selon le type : incendie, fin d'alerte, panne, test. */
function composer(p: Payload, type: string) {
  if (type === "alerte") {
    return { sujet: titre(p), texte: corpsTexte(p) };
  }
  if (type === "fin") {
    return { sujet: titreFin(p), texte: corpsFinTexte(p) };
  }
  if (type === "heartbeat") {
    const m = p?.message ??
      "La collecte satellite est interrompue : les alertes peuvent être suspendues.";
    return {
      sujet: "Alerte Incendie — surveillance interrompue",
      texte: `${m}\n\nVérifiez l'état du système dans l'application.`,
    };
  }
  const m = p?.message ?? "Cet appareil est opérationnel.";
  return {
    sujet: "Test — Alerte Incendie",
    texte: m,
  };
}

async function envoyerPush(cfg: Record<string, any>, dest: any, p: Payload, type: string) {
  const app = await appPush(cfg);
  const abonne = app.subscribe(dest);
  const c = composer(p, type);
  const body = JSON.stringify({
    titre: c.sujet,
    corps: c.texte,
    severite: type === "fin" ? "info" : (p?.severite ?? "info"),
    url: `./?evt=${p?.evenement_id ?? ""}`,
    lat: p?.lat,
    lon: p?.lon,
  });
  await abonne.pushTextMessage(body, {
    urgency: p?.severite === "critique" && type === "alerte"
      ? webpush.Urgency.High
      : webpush.Urgency.Normal,
    ttl: 6 * 3600,
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  await req.json().catch(() => ({}));
  if (!await autoriserOperation(req, "dispatch")) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("dispatch");
  const stats = {
    traitees: 0,
    envoyees: 0,
    echecs: 0,
    reprogrammees: 0,
    par_canal: {} as Record<string, number>,
  };

  try {
    const cfg = await config(true);

    // La file prête à l'envoi est définie en base : péremption des alertes
    // incendie à 2 h, temporisation, priorité au critique.
    const { data: file, error } = await sb.rpc("alertes_a_envoyer", { p_limite: 200 });
    if (error) throw new Error(error.message);
    const alertes = (file ?? []) as Array<Record<string, any>>;

    const idsCanaux = [...new Set(alertes.map((a) => a.canal_id).filter(Boolean))];
    const { data: canauxData } = idsCanaux.length
      ? await sb.from("canaux").select("id, type, destination, echecs").in("id", idsCanaux)
      : { data: [] as Array<Record<string, any>> };
    const canaux = new Map((canauxData ?? []).map((c) => [c.id, c]));

    const succes = async (a: Record<string, any>, canal: Record<string, any>) => {
      await sb.from("alertes").update({
        statut: "envoye",
        sent_at: new Date().toISOString(),
        tentatives: (a.tentatives ?? 0) + 1,
        erreur: null,
      }).eq("id", a.id);
      await sb.from("canaux").update({
        last_ok_at: new Date().toISOString(),
        echecs: 0,
        verifie: true,
        last_error: null,
      }).eq("id", canal.id);
      stats.envoyees++;
      stats.par_canal[canal.type] = (stats.par_canal[canal.type] ?? 0) + 1;
    };

    const echec = async (a: Record<string, any>, canal: Record<string, any>, e: unknown) => {
      const msg = String(e).slice(0, 800);
      const revoque = /\b(404|410)\b|gone|expired|unsubscrib/i.test(msg);
      const nbTentatives = (a.tentatives ?? 0) + 1;
      const nbEchecs = (canal.echecs ?? 0) + 1;
      const abandon = revoque || nbTentatives >= MAX_TENTATIVES || nbEchecs >= MAX_ECHECS;

      // Temporisation croissante : 1, 2, 4, 8 puis 16 minutes.
      const attenteMin = 2 ** (nbTentatives - 1);

      await sb.from("alertes").update({
        statut: abandon ? "echec" : "en_attente",
        tentatives: nbTentatives,
        prochaine_tentative_at: new Date(Date.now() + attenteMin * 60_000).toISOString(),
        erreur: msg,
      }).eq("id", a.id);
      await sb.from("canaux").update({
        echecs: nbEchecs,
        last_error: msg,
        actif: !(revoque || nbEchecs >= MAX_ECHECS),
      }).eq("id", canal.id);

      if (abandon) stats.echecs++;
      else stats.reprogrammees++;
    };

    const traiter = async (a: Record<string, any>) => {
      const canal = canaux.get(a.canal_id);
      stats.traitees++;
      if (!canal) {
        await sb.from("alertes").update({ statut: "echec", erreur: "canal supprimé" })
          .eq("id", a.id);
        stats.echecs++;
        return;
      }
      try {
        const p = a.payload as Payload;
        if (canal.type !== "webpush") {
          throw new Error(`canal désactivé : ${canal.type}`);
        }
        await envoyerPush(cfg, canal.destination, p, a.type);
        await succes(a, canal);
      } catch (e) {
        await echec(a, canal, e);
      }
    };

    for (let i = 0; i < alertes.length; i += CONCURRENCE) {
      await Promise.all(alertes.slice(i, i + CONCURRENCE).map(traiter));
    }

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
