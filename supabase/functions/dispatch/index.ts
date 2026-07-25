// =====================================================================
//  dispatch — vidage de la file d'alertes vers les 3 canaux
// ---------------------------------------------------------------------
//    Web Push  : VAPID + chiffrement aes128gcm (jsr:@negrel/webpush)
//    Telegram  : Bot API sendMessage
//    E-mail    : SMTP implicite TLS (Gmail par défaut)
//
//  Idempotent : une alerte déjà « envoyé » n'est jamais rejouée, grâce
//  à l'index unique (evenement_id, canal_id, severite). Un canal qui
//  échoue 5 fois, ou dont l'abonnement push est révoqué (404/410), est
//  désactivé automatiquement et signalé dans l'interface.
// =====================================================================
import { sb, config, json, CORS, ouvrirRun, fermerRun, verifierAdmin, estInterne } from "../_shared/mod.ts";
import { corpsHtml, corpsTelegram, corpsTexte, titre, type Payload } from "./messages.ts";
import * as webpush from "jsr:@negrel/webpush@^0.3";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const MAX_ECHECS = 5;

let serveurPush: webpush.ApplicationServer | null = null;
async function appPush(cfg: Record<string, any>) {
  if (serveurPush) return serveurPush;
  if (!cfg.vapid_jwk) throw new Error("vapid_jwk absent de la configuration");
  serveurPush = await webpush.ApplicationServer.new({
    contactInformation: String(cfg.vapid_subject ?? "mailto:admin@localhost"),
    vapidKeys: await webpush.importVapidKeys(cfg.vapid_jwk, { extractable: false }),
  });
  return serveurPush;
}

async function envoyerPush(cfg: any, dest: any, p: Payload, type: string) {
  const app = await appPush(cfg);
  const abonne = app.subscribe(dest);
  const body = JSON.stringify({
    titre: type === "alerte" ? titre(p) : type === "heartbeat" ? "Surveillance interrompue" : "Test — Alerte Incendie",
    corps: type === "alerte" ? corpsTexte(p) : (p?.message ?? "Le canal Web Push fonctionne."),
    severite: p?.severite ?? "info",
    url: `./?evt=${p?.evenement_id ?? ""}`,
    lat: p?.lat, lon: p?.lon,
  });
  await abonne.pushTextMessage(body, {
    urgency: p?.severite === "critique" ? webpush.Urgency.High : webpush.Urgency.Normal,
    ttl: 6 * 3600,
  });
}

async function envoyerTelegram(cfg: any, dest: any, p: Payload, type: string) {
  if (!cfg.telegram_token) throw new Error("telegram_token non configuré");
  const texte = type === "alerte"
    ? corpsTelegram(p)
    : type === "heartbeat"
    ? `*Surveillance interrompue*\n\n${p?.message ?? ""}`
    : "*Test — Alerte Incendie*\n\nLe canal Telegram fonctionne.";
  const r = await fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: dest.chat_id, text: texte, parse_mode: "Markdown",
      link_preview_options: { is_disabled: true }, disable_notification: false,
    }),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`telegram: ${j.description ?? r.status}`);
}

async function envoyerEmail(cfg: any, dest: any, p: Payload, type: string) {
  const s = cfg.smtp ?? {};
  if (!s.user || !s.pass) throw new Error("smtp non configuré (user/pass)");
  const client = new SMTPClient({
    connection: {
      hostname: s.host ?? "smtp.gmail.com",
      port: s.port ?? 465,
      tls: true,
      auth: { username: s.user, password: s.pass },
    },
  });
  try {
    const sujet = type === "alerte" ? titre(p)
      : type === "heartbeat" ? "Alerte Incendie — surveillance interrompue"
      : "Test — Alerte Incendie";
    await client.send({
      from: s.from ?? s.user,
      to: dest.adresse,
      subject: sujet,
      content: type === "alerte" ? corpsTexte(p) : (p?.message ?? "Le canal e-mail fonctionne."),
      html: type === "alerte" ? corpsHtml(p) : `<p>${p?.message ?? "Le canal e-mail fonctionne."}</p>`,
      priority: p?.severite === "critique" ? "high" : "normal",
    });
  } finally {
    await client.close().catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  await req.json().catch(() => ({}));
  if (!estInterne(req) && !await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("dispatch");
  const stats = { traitees: 0, envoyees: 0, echecs: 0, par_canal: {} as Record<string, number> };

  try {
    const cfg = await config(true);

    const { data: file, error } = await sb
      .from("alertes")
      .select("id, type, severite, payload, canal_id, canaux(id, type, destination, echecs)")
      .eq("statut", "en_attente")
      .lt("tentatives", 4)
      .order("created_at")
      .limit(100);
    if (error) throw new Error(error.message);

    for (const a of file ?? []) {
      const canal: any = a.canaux;
      stats.traitees++;

      if (!canal) {
        await sb.from("alertes").update({ statut: "echec", erreur: "canal supprimé" }).eq("id", a.id);
        stats.echecs++;
        continue;
      }

      try {
        const p = a.payload as Payload;
        if (canal.type === "webpush") await envoyerPush(cfg, canal.destination, p, a.type);
        else if (canal.type === "telegram") await envoyerTelegram(cfg, canal.destination, p, a.type);
        else if (canal.type === "email") await envoyerEmail(cfg, canal.destination, p, a.type);
        else throw new Error(`type de canal inconnu: ${canal.type}`);

        await sb.from("alertes").update({
          statut: "envoye", sent_at: new Date().toISOString(), tentatives: 1, erreur: null,
        }).eq("id", a.id);
        await sb.from("canaux").update({
          last_ok_at: new Date().toISOString(), echecs: 0, verifie: true, last_error: null,
        }).eq("id", canal.id);

        stats.envoyees++;
        stats.par_canal[canal.type] = (stats.par_canal[canal.type] ?? 0) + 1;
      } catch (e) {
        const msg = String(e).slice(0, 800);
        const revoque = /\b(404|410)\b|gone|expired|unsubscrib/i.test(msg);
        const nbEchecs = (canal.echecs ?? 0) + 1;

        await sb.from("alertes").update({
          statut: revoque || nbEchecs >= MAX_ECHECS ? "echec" : "en_attente",
          tentatives: 4, erreur: msg,
        }).eq("id", a.id);
        await sb.from("canaux").update({
          echecs: nbEchecs, last_error: msg, actif: !(revoque || nbEchecs >= MAX_ECHECS),
        }).eq("id", canal.id);

        stats.echecs++;
      }
    }

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
