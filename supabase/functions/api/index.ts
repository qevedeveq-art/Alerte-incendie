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
//    POST /api/canal-verifier   confirme un e-mail par code a 6 chiffres
//    POST /api/canal-supprimer
//    POST /api/zone             ajoute une zone par code INSEE
//    POST /api/zone-supprimer
//    POST /api/reglages         seuil, heures silencieuses, sensibilité
//    POST /api/test             alerte de test sur tous les canaux
//    POST /api/telegram-webhook liaison chat_id ↔ abonné
//  Anti-abus, indispensable pour un service ouvert au public :
//    - quota par IP sur la creation de compte et la recherche
//    - quota par abonne sur l'ajout de canal, de zone et les tests
//    - double opt-in obligatoire sur l'e-mail : sans code confirme,
//      aucune alerte n'est envoyee (sinon le service serait un relais
//      de spam et l'expediteur finirait sur liste noire)
//    - plafonds : 10 zones et 8 canaux par abonne
// =====================================================================
import { sb, config, json, CORS, ipAppelant, quota, TROP_DE_REQUETES } from "../_shared/mod.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function abonneParJeton(req: Request) {
  const t = req.headers.get("x-token") ?? new URL(req.url).searchParams.get("token");
  if (!t || t.length < 32 || t.length > 128) return null;
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

const codeA6Chiffres = () =>
  String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/$/, "") || "etat";
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const cfg = await config();
  const ip = ipAppelant(req);

  try {
    // ---------- routes publiques ----------
    if (route === "vapid") return json({ publicKey: cfg.vapid_public });

    if (route === "communes") {
      if (!await quota(`communes:${ip}`, 60, 60)) return json(TROP_DE_REQUETES, 429);
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
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
      // 5 comptes par heure et par IP : suffisant pour une famille, dissuasif pour un robot
      if (!await quota(`inscription:${ip}`, 5, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data, error } = await sb.from("abonnes")
        .insert({ nom: String(body.nom ?? "").slice(0, 60) || null })
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
        libelle: String(msg?.chat?.first_name ?? "Telegram").slice(0, 40),
        // chat_id fourni par Telegram lui-meme : le canal est verifie par construction
        verifie: true, actif: true, echecs: 0,
      }, { onConflict: "abonne_id,type,destination", ignoreDuplicates: false });
      await repondre("Canal Telegram activé. Vous recevrez ici les alertes incendie de vos zones surveillées.");
      return json({ ok: true });
    }

    // ---------- routes authentifiées ----------
    const ab = await abonneParJeton(req);
    if (!ab) return json({ erreur: "jeton invalide" }, 401);

    if (route === "etat") {
      if (!await quota(`etat:${ab.id}`, 120, 3600)) return json(TROP_DE_REQUETES, 429);
      const [zones, evts, sante, canaux, dets, meteo] = await Promise.all([
        sb.rpc("zones_abonne", { p_abonne: ab.id }),
        sb.rpc("evenements_abonne", { p_abonne: ab.id, p_jours: 30 }),
        sb.from("v_sante").select("*").single(),
        sb.from("canaux")
          .select("id,type,libelle,actif,verifie,last_ok_at,last_error,echecs")
          .eq("abonne_id", ab.id),
        sb.rpc("detections_abonne", { p_abonne: ab.id, p_heures: 72 }),
        sb.rpc("meteo_abonne", { p_abonne: ab.id }),
      ]);
      return json({
        abonne: {
          id: ab.id, nom: ab.nom, email: ab.email, seuil_min: ab.seuil_min,
          quiet_start: ab.quiet_start, quiet_end: ab.quiet_end,
          ref_libelle: ab.ref_libelle ?? null,
          ref_definie: !!ab.ref_geom,
        },
        zones: zones.data ?? [], evenements: evts.data ?? [],
        detections: dets.data ?? [], canaux: canaux.data ?? [],
        sante: sante.data ?? null, meteo: meteo.data ?? {},
        vapid: cfg.vapid_public,
        telegram_bot: cfg.telegram_bot_nom ?? null,
      });
    }

    if (route === "canal") {
      if (!await quota(`canal:${ab.id}`, 10, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data: place } = await sb.rpc("verifier_plafonds", { p_abonne: ab.id, p_quoi: "canaux" });
      if (!place) return json({ erreur: "maximum de 8 canaux atteint" }, 400);

      const { type, destination, libelle } = body;
      if (!["webpush", "email", "telegram"].includes(type)) return json({ erreur: "type invalide" }, 400);

      // --- e-mail : double opt-in obligatoire ---
      if (type === "email") {
        const adresse = String(destination?.adresse ?? "").trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(adresse) || adresse.length > 254) {
          return json({ erreur: "adresse e-mail invalide" }, 400);
        }
        // 2 sollicitations maximum par adresse et par 24 h, quel que soit l'abonne :
        // empeche d'utiliser le service pour harceler une adresse tierce
        if (!await quota(`email:${adresse}`, 2, 86400)) {
          return json({ erreur: "cette adresse a deja recu un code recemment" }, 429);
        }

        const code = codeA6Chiffres();
        const { data: canal, error } = await sb.from("canaux").upsert({
          abonne_id: ab.id, type: "email", destination: { adresse },
          libelle: adresse, actif: true, verifie: false, echecs: 0, last_error: null,
          code_verif: code,
          code_expire_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          tentatives_verif: 0,
        }, { onConflict: "abonne_id,type,destination" }).select("id").single();
        if (error) throw new Error(error.message);

        await sb.from("alertes").insert({
          canal_id: canal.id, abonne_id: ab.id, type: "test",
          severite: "info", statut: "en_attente",
          payload: {
            severite: "info",
            message: `Votre code de confirmation est ${code}\n\n` +
              `Saisissez-le dans l'application pour activer les alertes incendie sur cette adresse. ` +
              `Le code expire dans 30 minutes.\n\n` +
              `Si vous n'avez rien demande, ignorez ce message : sans ce code, aucune alerte ne sera envoyee ici.`,
          },
        });
        await declencherDispatch();
        return json({ ok: true, verification_requise: true, canal_id: canal.id });
      }

      // --- push et telegram : verifies par construction ---
      const { data, error } = await sb.from("canaux").upsert({
        abonne_id: ab.id, type, destination,
        libelle: String(libelle ?? "").slice(0, 40) || null,
        actif: true, verifie: true, echecs: 0, last_error: null,
      }, { onConflict: "abonne_id,type,destination" }).select("id,type,libelle").single();
      if (error) throw new Error(error.message);
      return json({ ok: true, canal: data });
    }

    if (route === "canal-verifier") {
      if (!await quota(`verif:${ab.id}`, 20, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data: c } = await sb.from("canaux")
        .select("id, code_verif, code_expire_at, tentatives_verif")
        .eq("id", body.id).eq("abonne_id", ab.id).maybeSingle();
      if (!c) return json({ erreur: "canal introuvable" }, 404);
      if ((c.tentatives_verif ?? 0) >= 5) return json({ erreur: "trop d'essais, redemandez un code" }, 429);
      if (!c.code_expire_at || new Date(c.code_expire_at) < new Date()) {
        return json({ erreur: "code expire, redemandez-en un" }, 400);
      }

      const fourni = String(body.code ?? "").trim();
      if (fourni !== c.code_verif) {
        await sb.from("canaux").update({ tentatives_verif: (c.tentatives_verif ?? 0) + 1 }).eq("id", c.id);
        return json({ erreur: "code incorrect" }, 400);
      }
      await sb.from("canaux").update({
        verifie: true, code_verif: null, code_expire_at: null, tentatives_verif: 0,
      }).eq("id", c.id);
      return json({ ok: true });
    }

    if (route === "canal-supprimer") {
      await sb.from("canaux").delete().eq("id", body.id).eq("abonne_id", ab.id);
      return json({ ok: true });
    }

    if (route === "zone") {
      if (!await quota(`zone:${ab.id}`, 15, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data: place } = await sb.rpc("verifier_plafonds", { p_abonne: ab.id, p_quoi: "zones" });
      if (!place) return json({ erreur: "maximum de 10 zones atteint" }, 400);

      const code = String(body.code ?? "").trim();
      if (!/^[0-9][0-9AB][0-9]{3}$/i.test(code)) return json({ erreur: "code INSEE invalide" }, 400);
      if (!await assurerCommune(code)) return json({ erreur: "commune introuvable" }, 404);

      const { data: z, error } = await sb.rpc("upsert_zone", {
        p_code: code,
        p_limitrophes: body.limitrophes !== false,
        p_buffer_m: Math.min(50000, Math.max(0, Number(body.buffer_m ?? 3000) || 0)),
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
      if (!await quota(`reglages:${ab.id}`, 30, 3600)) return json(TROP_DE_REQUETES, 429);
      const maj: Record<string, unknown> = {};
      if (body.seuil_min && ["info", "alerte", "critique"].includes(body.seuil_min)) maj.seuil_min = body.seuil_min;
      if ("quiet_start" in body) maj.quiet_start = body.quiet_start || null;
      if ("quiet_end" in body) maj.quiet_end = body.quiet_end || null;
      if ("nom" in body) maj.nom = String(body.nom ?? "").slice(0, 60) || null;
      if (Object.keys(maj).length) await sb.from("abonnes").update(maj).eq("id", ab.id);

      // Point de reference : la distance qui compte pour un abonne est
      // celle qui le separe de chez lui, pas du centre de la commune.
      if ("ref_lat" in body || "ref_lon" in body) {
        const lat = body.ref_lat == null ? null : Number(body.ref_lat);
        const lon = body.ref_lon == null ? null : Number(body.ref_lon);
        if (lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) {
          return json({ erreur: "latitude invalide" }, 400);
        }
        if (lon !== null && (!Number.isFinite(lon) || Math.abs(lon) > 180)) {
          return json({ erreur: "longitude invalide" }, 400);
        }
        const { error } = await sb.rpc("maj_reference", {
          p_abonne: ab.id, p_lat: lat, p_lon: lon,
          p_libelle: String(body.ref_libelle ?? "").slice(0, 40) || null,
        });
        if (error) throw new Error(error.message);
      }

      if (body.zone_id) {
        const zmaj: Record<string, unknown> = {};
        if (["sensible", "equilibre", "conservateur"].includes(body.sensibilite)) zmaj.sensibilite = body.sensibilite;
        if (body.buffer_m != null) zmaj.buffer_m = Math.min(50000, Math.max(0, Number(body.buffer_m) || 0));
        if ("limitrophes" in body) zmaj.inclure_limitrophes = !!body.limitrophes;
        if (Object.keys(zmaj).length) {
          // on ne modifie qu'une zone a laquelle l'abonne est rattache
          const { data: lien } = await sb.from("zone_abonnes").select("zone_id")
            .eq("zone_id", body.zone_id).eq("abonne_id", ab.id).maybeSingle();
          if (!lien) return json({ erreur: "zone non rattachée à cet abonné" }, 403);
          await sb.from("zones").update(zmaj).eq("id", body.zone_id);
          await sb.rpc("refresh_zone_geom", { p_zone_id: body.zone_id });
        }
      }
      return json({ ok: true });
    }

    if (route === "test") {
      if (!await quota(`test:${ab.id}`, 5, 3600)) return json(TROP_DE_REQUETES, 429);
      // un canal non verifie ne recoit rien : evite d'en faire un vecteur d'envoi
      const { data: canaux } = await sb.from("canaux")
        .select("id").eq("abonne_id", ab.id).eq("actif", true).eq("verifie", true);
      if (!canaux?.length) return json({ erreur: "aucun canal vérifié" }, 400);

      const faux = {
        zone: "Test", commune: "Test", dans_commune: true, distance_m: 0,
        severite: "info", nb_detections: 1, frp_max: 12.3,
        sources: ["VIIRS_SNPP"], lat: 43.649, lon: 1.3197,
        debut_ts: new Date().toISOString(), evenement_id: "test",
        message: "Test réussi : ce canal est opérationnel et recevra les alertes incendie.",
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
    console.error("api", route, String(e));
    return json({ erreur: "erreur interne" }, 500);
  }
});
