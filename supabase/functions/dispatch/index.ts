// =====================================================================
//  dispatch — vidage de la file d'alertes vers les 3 canaux
// ---------------------------------------------------------------------
//    Web Push  : VAPID + chiffrement aes128gcm (jsr:@negrel/webpush)
//    Telegram  : Bot API sendMessage, MarkdownV2 echappe
//    E-mail    : SMTP implicite TLS (Gmail par defaut)
//
//  Trois corrections de fiabilite par rapport a la version precedente :
//
//  1. REPRISE REELLE. On ecrivait `tentatives = 4` des le premier echec
//     alors que la selection filtrait sur `tentatives < 4` : l'alerte
//     n'etait jamais rejouee et restait 'en_attente' pour toujours. Le
//     compteur est desormais incremente d'une unite, avec temporisation
//     croissante, et la peremption est geree en base (alertes_a_envoyer).
//
//  2. UNE SEULE CONNEXION SMTP pour tout le lot. On ouvrait une poignee
//     de main TLS complete par message : sous un vrai feu, avec beaucoup
//     d'abonnes, la fonction atteignait sa limite de temps avant d'avoir
//     vide la file — precisement au moment ou elle sert.
//
//  3. ENVOIS CONCURRENTS pour push et Telegram, qui sont des appels HTTP
//     independants. L'e-mail reste sequentiel : il partage sa connexion.
//
//  Idempotent : une alerte deja « envoye » n'est jamais rejouee, grace
//  a l'index unique (evenement, canal, severite, type). Un canal qui
//  echoue 5 fois, ou dont l'abonnement push est revoque (404/410), est
//  desactive automatiquement et signale dans l'interface.
// =====================================================================
import {
  config,
  configVersion,
  CORS,
  estInterne,
  fermerRun,
  json,
  ouvrirRun,
  sb,
  verifierAdmin,
} from "../_shared/mod.ts";
import { echapperHtml, echapperMdV2 as md } from "../_shared/format.ts";
import {
  corpsFinHtml,
  corpsFinTelegram,
  corpsFinTexte,
  corpsHtml,
  corpsTelegram,
  corpsTexte,
  type Payload,
  titre,
  titreFin,
} from "./messages.ts";
import * as webpush from "jsr:@negrel/webpush@^0.3";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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
    return { sujet: titre(p), texte: corpsTexte(p), html: corpsHtml(p), tg: corpsTelegram(p) };
  }
  if (type === "fin") {
    return {
      sujet: titreFin(p),
      texte: corpsFinTexte(p),
      html: corpsFinHtml(p),
      tg: corpsFinTelegram(p),
    };
  }
  if (type === "heartbeat") {
    const m = p?.message ??
      "La collecte satellite est interrompue : les alertes peuvent être suspendues.";
    return {
      sujet: "Alerte Incendie — surveillance interrompue",
      texte: `${m}\n\nVérifiez l'état du système dans l'application.`,
      html: `<p style="font-size:16px"><b>Surveillance interrompue</b></p>` +
        `<p>${echapperHtml(m)}</p>` +
        `<p style="color:#777;font-size:12px">Vérifiez l'état du système dans l'application.</p>`,
      tg: `${md("!!!")} *${md("Surveillance interrompue")}*\n\n${md(m)}`,
    };
  }
  const m = p?.message ?? "Ce canal est opérationnel.";
  return {
    sujet: "Test — Alerte Incendie",
    texte: m,
    html: `<p>${echapperHtml(m)}</p>`,
    tg: `*${md("Test — Alerte Incendie")}*\n\n${md(m)}`,
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

async function envoyerTelegram(cfg: Record<string, any>, dest: any, p: Payload, type: string) {
  if (!cfg.telegram_token) throw new Error("telegram_token non configuré");
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: dest.chat_id,
      text: composer(p, type).tg,
      parse_mode: "MarkdownV2",
      link_preview_options: { is_disabled: true },
      disable_notification: false,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description ?? r.status}`);
}

/** Connexion SMTP paresseuse, partagée par tout le lot. */
function poolSmtp(cfg: Record<string, any>) {
  let client: SMTPClient | null = null;
  return {
    async envoyer(dest: any, p: Payload, type: string) {
      const s = cfg.smtp ?? {};
      if (!s.user || !s.pass) throw new Error("smtp non configuré (user/pass)");
      if (!client) {
        client = new SMTPClient({
          connection: {
            hostname: s.host ?? "smtp.gmail.com",
            port: s.port ?? 465,
            tls: true,
            auth: { username: s.user, password: s.pass },
          },
        });
      }
      const c = composer(p, type);
      await client.send({
        from: s.from ?? s.user,
        to: dest.adresse,
        subject: c.sujet,
        content: c.texte,
        html: c.html,
        priority: p?.severite === "critique" && type === "alerte" ? "high" : "normal",
      });
    },
    async fermer() {
      if (client) {
        try {
          await client.close();
        } catch { /* connexion déjà fermée */ }
        client = null;
      }
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  await req.json().catch(() => ({}));
  if (!estInterne(req) && !await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("dispatch");
  const stats = {
    traitees: 0,
    envoyees: 0,
    echecs: 0,
    reprogrammees: 0,
    par_canal: {} as Record<string, number>,
  };

  // Déclaré hors du try pour être fermé dans tous les cas, mais renseigné
  // dedans : une configuration illisible doit clore le run proprement.
  let smtp: ReturnType<typeof poolSmtp> | null = null;

  try {
    const cfg = await config(true);
    smtp = poolSmtp(cfg);

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
        if (canal.type === "webpush") await envoyerPush(cfg, canal.destination, p, a.type);
        else if (canal.type === "telegram") {
          await envoyerTelegram(cfg, canal.destination, p, a.type);
        } else if (canal.type === "email") await smtp!.envoyer(canal.destination, p, a.type);
        else throw new Error(`type de canal inconnu: ${canal.type}`);
        await succes(a, canal);
      } catch (e) {
        await echec(a, canal, e);
      }
    };

    // Push et Telegram : appels HTTP indépendants, traités par vagues.
    const paralleles = alertes.filter((a) => canaux.get(a.canal_id)?.type !== "email");
    for (let i = 0; i < paralleles.length; i += CONCURRENCE) {
      await Promise.all(paralleles.slice(i, i + CONCURRENCE).map(traiter));
    }

    // E-mail : séquentiel, sur une connexion SMTP unique.
    for (const a of alertes.filter((x) => canaux.get(x.canal_id)?.type === "email")) {
      await traiter(a);
    }

    await smtp?.fermer();
    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await smtp?.fermer();
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
