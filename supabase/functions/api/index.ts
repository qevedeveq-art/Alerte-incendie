// =====================================================================
//  api — façade publique consommée par la PWA
// ---------------------------------------------------------------------
//  Authentification par jeton d'abonné (public.abonnes.token), transmis
//  en en-tête x-token. Aucune table n'est exposée directement : RLS
//  refuse tout et seules ces routes écrivent, via le service role.
//
//    GET  /api/etat             état complet (zones, évènements, santé)
//    GET  /api/vapid            clé publique Web Push
//    GET  /api/communes?q=      recherche de commune (France entière)
//    POST /api/inscription      crée un abonné, renvoie son jeton
//    POST /api/canal            ajoute un canal (webpush|email|telegram)
//    POST /api/canal-supprimer
//    POST /api/zone             ajoute une zone par code INSEE
//    POST /api/zone-supprimer
//    POST /api/reglages         seuil, heures silencieuses, sensibilité
//    POST /api/test             alerte de test sur tous les canaux
//    POST /api/telegram-webhook liaison chat_id ↔ abonné
// =====================================================================
import { sb, config, json, CORS } from "../_shared/mod.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function abonneParJeton(req: Request) {
  const t = req.headers.get("x-token") ?? new URL(req.url).searchParams.get("token");
  if (!t) return null;
  const { data } = await sb.from("abonnes").select("*").eq("token", t).maybeSingle();
  if (data) {
    sb.from("abonnes").update({ last_seen_at: new Date().toISOString() })
      .eq("id", data.id).then(() => {});
  }
  return data;
}

/** Charge à la demande le département d'une commune absente du cache. */
async function assurerCommune(code: string) {
  const { data } = await sb.from("communes").select("code").eq("code", code).maybeSingle();
  if (data) return true;
  const dep = code.startsWith("97") ? code.slice(0, 3) : code.slice(0, 2);
  const cfg = await config();
  const r = await fetch(`${URL_BASE}/functions/v1/load-communes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": String(cfg.admin_key) },
    body: JSON.stringify({ departements: [dep] }),
  });
  return r.ok;
}

async function declencherDispatch() {
  await fetch(`${URL_BASE}/functions/v1/dispatch`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
    body: JSON.stringify({ interne: true }),
  }).catch(() => {});
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "") || "etat";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const cfg = await config();

  try {
    // ---------- routes publiques ----------
    if (route === "vapid") return json({ publicKey: cfg.vapid_public });

    if (route === "communes") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (q.length < 2) return json([]);
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?nom=${encodeURIComponent(q)}` +
        `&fields=nom,code,codesPostaux,departement,population&boost=population&limit=12`,
      );
      const l = await r.json();
      return json((Array.isArray(l) ? l : []).map((c: any) => ({
        code: c.code, nom: c.nom, cp: c.codesPostaux?.[0] ?? null,
        departement: c.departement?.nom ?? null, population: c.population ?? null,
      })));
    }

    if (route === "inscription") {
      const { data, error } = await sb.from("abonnes")
        .insert({ nom: body.nom ?? null, email: body.email ?? null })
        .select("id, token, seuil_min, quiet_start, quiet_end").single();
      if (error) throw new Error(error.message);
      return json({ ok: true, abonne: data });
    }

    if (route === "telegram-webhook") {
      // Le bot ne fait qu'une chose : lier un chat_id à un jeton d'abonné
      // via la commande /start <jeton>.
      const msg = body?.message;
      const texte: string = msg?.text ?? "";
      const chatId = msg?.chat?.id;
      if (!chatId) return json({ ok: true });

      const repondre = (t: string) =>
        fetch(`https://api.telegram.org/bot${cfg.telegram_token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: t, parse_mode: "Markdown" }),
        }).catch(() => {});

      const m = texte.match(/^\/start\s+(\S+)/);
      if (!m) {
        await repondre("Pour activer les alertes, ouvrez l'application et utilisez le bouton *Connecter Telegram*.");
        return json({ ok: true });
      }
      const { data: ab } = await sb.from("abonnes").select("id, nom").eq("token", m[1]).maybeSingle();
      if (!ab) {
        await repondre("Jeton invalide ou expiré.");
        return json({ ok: true });
      }
      await sb.from("canaux").upsert({
        abonne_id: ab.id, type: "telegram",
        destination: { chat_id: chatId },
        libelle: msg?.chat?.first_name ?? "Telegram",
        verifie: true, actif: true, echecs: 0,
      }, { onConflict: "abonne_id,type,destination", ignoreDuplicates: false });
      await repondre("Canal Telegram activé. Vous recevrez ici les alertes incendie de vos zones surveillées.");
      return json({ ok: true });
    }

    // ---------- routes authentifiées ----------
    const ab = await abonneParJeton(req);
    if (!ab) return json({ erreur: "jeton invalide" }, 401);

    if (route === "etat") {
      const [zones, evts, sante, canaux, dets] = await Promise.all([
        sb.rpc("zones_abonne", { p_abonne: ab.id }),
        sb.rpc("evenements_abonne", { p_abonne: ab.id, p_jours: 30 }),
        sb.from("v_sante").select("*").single(),
        sb.from("canaux")
          .select("id,type,libelle,actif,verifie,last_ok_at,last_error,echecs")
          .eq("abonne_id", ab.id),
        sb.rpc("detections_abonne", { p_abonne: ab.id, p_heures: 72 }),
      ]);
      return json({
        abonne: {
          id: ab.id, nom: ab.nom, email: ab.email, seuil_min: ab.seuil_min,
          quiet_start: ab.quiet_start, quiet_end: ab.quiet_end,
        },
        zones: zones.data ?? [], evenements: evts.data ?? [],
        detections: dets.data ?? [], canaux: canaux.data ?? [],
        sante: sante.data ?? null,
        vapid: cfg.vapid_public,
        telegram_bot: cfg.telegram_bot_nom ?? null,
      });
    }

    if (route === "canal") {
      const { type, destination, libelle } = body;
      if (!["webpush", "email", "telegram"].includes(type)) return json({ erreur: "type invalide" }, 400);
      if (type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(destination?.adresse ?? "")) {
        return json({ erreur: "adresse e-mail invalide" }, 400);
      }
      const { data, error } = await sb.from("canaux").upsert({
        abonne_id: ab.id, type, destination, libelle: libelle ?? null,
        actif: true, echecs: 0, last_error: null,
      }, { onConflict: "abonne_id,type,destination" }).select("id,type,libelle").single();
      if (error) throw new Error(error.message);
      return json({ ok: true, canal: data });
    }

    if (route === "canal-supprimer") {
      await sb.from("canaux").delete().eq("id", body.id).eq("abonne_id", ab.id);
      return json({ ok: true });
    }

    if (route === "zone") {
      const code = String(body.code ?? "").trim();
      if (!/^[0-9][0-9AB][0-9]{3}$/i.test(code)) return json({ erreur: "code INSEE invalide" }, 400);
      if (!await assurerCommune(code)) return json({ erreur: "commune introuvable" }, 404);

      const { data: z, error } = await sb.rpc("upsert_zone", {
        p_code: code,
        p_limitrophes: body.limitrophes !== false,
        p_buffer_m: Number(body.buffer_m ?? 3000),
        p_sensibilite: ["sensible", "equilibre", "conservateur"].includes(body.sensibilite)
          ? body.sensibilite : "equilibre",
      });
      if (error) throw new Error(error.message);
      const zone = Array.isArray(z) ? z[0] : z;
      await sb.from("zone_abonnes").upsert({ zone_id: zone.id, abonne_id: ab.id });
      return json({ ok: true, zone: { id: zone.id, nom: zone.nom, limitrophes: zone.limitrophes } });
    }

    if (route === "zone-supprimer") {
      await sb.from("zone_abonnes").delete().eq("zone_id", body.id).eq("abonne_id", ab.id);
      const { count } = await sb.from("zone_abonnes")
        .select("abonne_id", { count: "exact", head: true }).eq("zone_id", body.id);
      if ((count ?? 0) === 0) await sb.from("zones").update({ actif: false }).eq("id", body.id);
      return json({ ok: true });
    }

    if (route === "reglages") {
      const maj: Record<string, unknown> = {};
      if (body.seuil_min && ["info", "alerte", "critique"].includes(body.seuil_min)) maj.seuil_min = body.seuil_min;
      if ("quiet_start" in body) maj.quiet_start = body.quiet_start || null;
      if ("quiet_end" in body) maj.quiet_end = body.quiet_end || null;
      if ("nom" in body) maj.nom = body.nom || null;
      if (Object.keys(maj).length) await sb.from("abonnes").update(maj).eq("id", ab.id);

      if (body.zone_id) {
        const zmaj: Record<string, unknown> = {};
        if (["sensible", "equilibre", "conservateur"].includes(body.sensibilite)) zmaj.sensibilite = body.sensibilite;
        if (body.buffer_m != null) zmaj.buffer_m = Math.min(50000, Math.max(0, Number(body.buffer_m)));
        if ("limitrophes" in body) zmaj.inclure_limitrophes = !!body.limitrophes;
        if (Object.keys(zmaj).length) {
          await sb.from("zones").update(zmaj).eq("id", body.zone_id);
          await sb.rpc("refresh_zone_geom", { p_zone_id: body.zone_id });
        }
      }
      return json({ ok: true });
    }

    if (route === "test") {
      const { data: canaux } = await sb.from("canaux")
        .select("id").eq("abonne_id", ab.id).eq("actif", true);
      if (!canaux?.length) return json({ erreur: "aucun canal actif" }, 400);

      const faux = {
        zone: "Test", commune: "Test", dans_commune: true, distance_m: 0,
        severite: "info", nb_detections: 1, frp_max: 12.3,
        sources: ["VIIRS_SNPP"], lat: 43.649, lon: 1.3197,
        debut_ts: new Date().toISOString(), evenement_id: "test",
        message: "Test réussi : ce canal est opérationnel.",
      };
      await sb.from("alertes").insert(canaux.map((c) => ({
        canal_id: c.id, abonne_id: ab.id, type: "test",
        severite: "info", statut: "en_attente", payload: faux,
      })));
      await declencherDispatch();
      return json({ ok: true, canaux: canaux.length });
    }

    return json({ erreur: `route inconnue: ${route}` }, 404);
  } catch (e) {
    return json({ erreur: String(e) }, 500);
  }
});
