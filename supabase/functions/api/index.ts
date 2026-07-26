// =====================================================================
//  api — façade publique consommée par la PWA
// ---------------------------------------------------------------------
//  Authentification par jeton d'abonné (public.abonnes.token), transmis
//  en en-tête x-token. Aucune table n'est exposée directement : RLS
//  refuse tout et seules ces routes écrivent, via le service role.
//
//    GET  /api/etat             état complet (zones, évènements, santé)
//    GET  /api/vapid            clé publique Web Push
//    GET  /api/informations     informations légales publiques
//    GET  /api/carte            indices de feu nationaux corrélés
//    GET  /api/sante-publique   fraîcheur des collectes et de pg_cron
//    GET  /api/contexte         informations locales publiées d'un évènement
//    GET  /api/contexte-moderation  file d'associations à valider (admin_key)
//    POST /api/contexte-moderer     décision motivée et auditée (admin_key)
//    GET  /api/communes?q=      recherche de commune (France entière)
//    POST /api/inscription      crée un abonné, renvoie son jeton
//    POST /api/canal            ajoute un appareil (Web Push)
//    POST /api/canal-verifier   retiré temporairement (410)
//    POST /api/canal-supprimer
//    POST /api/zone             ajoute une zone par code INSEE
//    POST /api/zone-supprimer
//    POST /api/reglages         seuil, heures silencieuses, sensibilité
//    POST /api/test             alerte de test sur les appareils actifs
//    GET  /api/compte-exporter  export des données personnelles
//    POST /api/compte-supprimer effacement irréversible du compte
//    POST /api/telegram-webhook retiré temporairement (accusé sans action)
//  Anti-abus, indispensable pour un service ouvert au public :
//    - quota par IP sur la creation de compte et la recherche
//    - quota par abonne sur l'ajout d'appareil, de zone et les tests
//    - plafond : 10 zones et 8 appareils par abonne
// =====================================================================
import {
  autoriserOperation,
  config,
  CORS,
  ipAppelant,
  json,
  normaliserAbonnementPush,
  quota,
  sb,
  TROP_DE_REQUETES,
} from "../_shared/mod.ts";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const SRK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CONDITIONS_VERSION = "2026-07-26";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Empreinte d'acteur pour la trace de modération : jamais l'IP en clair. */
async function acteurHash(req: Request, sel: unknown): Promise<string> {
  const brut = `${ipAppelant(req)}|${String(sel ?? "")}`;
  const empreinte = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(brut));
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, "0")).join("");
}

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
  const r = await fetch(`${URL_BASE}/functions/v1/load-communes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SRK}` },
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
  const ip = ipAppelant(req);

  try {
    const cfg = await config();
    // ---------- routes publiques ----------
    if (route === "vapid") return json({ publicKey: cfg.vapid_public });

    if (route === "informations") {
      if (!await quota(`informations:${ip}`, 120, 3600)) return json(TROP_DE_REQUETES, 429);
      return json({
        conditions_version: CONDITIONS_VERSION,
        responsable_traitement: cfg.responsable_traitement ?? null,
        contact_rgpd: cfg.contact_rgpd ?? null,
        nom_service: "Alerte Incendie",
      });
    }

    if (route === "sante-publique") {
      if (!await quota(`sante-publique:${ip}`, 60, 60)) return json(TROP_DE_REQUETES, 429);
      const { data, error } = await sb.rpc("sante_publique");
      if (error) throw new Error(`sante publique: ${error.message}`);
      return json(data ?? { ok: false, statut: "indisponible" }, data?.ok === false ? 503 : 200);
    }

    if (route === "contexte") {
      if (!await quota(`contexte:${ip}`, 60, 60)) return json(TROP_DE_REQUETES, 429);
      // La clé attendue est un identifiant d'évènement. La carte envoyait
      // auparavant son identifiant d'affichage (« sat-… », « cit-… ») : la
      // jointure ne pouvait jamais aboutir. On refuse explicitement tout ce
      // qui n'est pas un uuid plutôt que de laisser une erreur SQL se
      // traduire en rubrique vide et silencieuse.
      const evenementId = url.searchParams.get("evenement") ??
        url.searchParams.get("evenement_id") ?? url.searchParams.get("groupe") ?? "";
      if (!UUID.test(evenementId)) return json({ mentions: [], total: 0 });

      const { data, error } = await sb
        .from("evenement_mentions")
        .select(
          "score, raisons, distance_km, ecart_heures, mentions_contexte (titre, resume, url_canonical, date_publication, sources_contexte (nom, type, attribution))",
        )
        .eq("evenement_id", evenementId)
        .eq("decision", "associe")
        .order("score", { ascending: false })
        .limit(5);

      if (error) {
        console.error("api contexte", error.message);
        return json({ mentions: [], total: 0 });
      }

      const mentions = (data || []).map((item: any) => {
        const m = item.mentions_contexte || {};
        const s = m.sources_contexte || {};
        return {
          score: item.score,
          raisons: item.raisons || [],
          source_nom: s.nom || "Source locale",
          source_type: s.type || "media",
          attribution: s.attribution || null,
          titre: m.titre || "",
          resume: m.resume || null,
          url: m.url_canonical || "#",
          date_publication: m.date_publication || null,
        };
      });

      return json({ mentions, total: mentions.length });
    }

    // ---------- file de modération du contexte, clé admin et audit ----------
    //  Une association proposée par le barème n'est publiée qu'après
    //  décision humaine motivée. La file ne contient ni auteur, ni
    //  identité, ni empreinte réseau : uniquement le contenu public, sa
    //  source et la raison du rapprochement.
    if (req.method === "GET" && route === "contexte-moderation") {
      if (!await autoriserOperation(req, "contexte:moderation:lire", false)) {
        return json({ erreur: "non autorisé" }, 401);
      }
      const { data, error } = await sb.rpc("moderation_contexte", { p_limite: 100 });
      if (error) throw new Error(`moderation contexte: ${error.message}`);
      return json({ ok: true, associations: data ?? [] });
    }

    if (req.method === "POST" && route === "contexte-moderer") {
      if (!await autoriserOperation(req, "contexte:moderation:decider", false)) {
        return json({ erreur: "non autorisé" }, 401);
      }
      const lien = String(body.lien_id ?? "");
      if (!UUID.test(lien)) return json({ erreur: "association invalide" }, 400);
      const decision = String(body.decision ?? "");
      if (!["associe", "rejete", "retire"].includes(decision)) {
        return json({ erreur: "décision inconnue" }, 400);
      }
      const motif = String(body.motif ?? "").trim().slice(0, 500);
      if (motif.length < 5) return json({ erreur: "motif obligatoire" }, 400);

      const { data, error } = await sb.rpc("moderer_mention", {
        p_lien: lien,
        p_decision: decision,
        p_motif: motif,
        p_acteur_hash: await acteurHash(req, cfg.sel_ip),
      });
      if (error) throw new Error(`moderer mention: ${error.message}`);
      return json(data ?? { ok: false }, data?.ok === false ? 400 : 200);
    }

    if (route === "carte") {
      if (!await quota(`carte:${ip}`, 120, 60)) return json(TROP_DE_REQUETES, 429);
      const lireNombre = (nom: string, defaut: number, min: number, max: number) => {
        const valeur = url.searchParams.get(nom);
        if (valeur === null || valeur.trim() === "") return defaut;
        const brut = Number(valeur);
        return Number.isFinite(brut) ? Math.min(max, Math.max(min, brut)) : defaut;
      };
      const heures = Math.round(lireNombre("heures", 24, 1, 72));
      const ouest = lireNombre("ouest", -5.5, -180, 180);
      const sud = lireNombre("sud", 41, -90, 90);
      const est = lireNombre("est", 10, -180, 180);
      const nord = lireNombre("nord", 51.5, -90, 90);
      const limite = Math.round(lireNombre("limite", 300, 1, 500));
      if (ouest >= est || sud >= nord) return json({ erreur: "emprise de carte invalide" }, 400);

      const { data, error } = await sb.rpc("feux_carte", {
        p_heures: heures,
        p_ouest: ouest,
        p_sud: sud,
        p_est: est,
        p_nord: nord,
        p_limite: limite,
      });
      if (error) throw new Error(`carte: ${error.message}`);
      return json({
        feux: Array.isArray(data) ? data : [],
        heures,
        methode: {
          distance_correlation_m: 2000,
          fenetre_citoyenne_h: 12,
          familles_independantes: ["polaire", "geostationnaire", "citoyen", "aerien"],
        },
      });
    }

    if (route === "communes") {
      if (!await quota(`communes:${ip}`, 60, 60)) return json(TROP_DE_REQUETES, 429);
      const q = (url.searchParams.get("q") ?? "").trim().slice(0, 60);
      if (q.length < 2) return json([]);
      const critere = /^\d{5}$/.test(q)
        ? `codePostal=${encodeURIComponent(q)}`
        : `nom=${encodeURIComponent(q)}`;
      const r = await fetch(
        `https://geo.api.gouv.fr/communes?${critere}` +
          `&fields=nom,code,codesPostaux,departement,population,centre` +
          `&boost=population&limit=12`,
      );
      const l = await r.json();
      return json((Array.isArray(l) ? l : []).map((c: any) => ({
        code: c.code,
        nom: c.nom,
        cp: c.codesPostaux?.[0] ?? null,
        departement: c.departement?.nom ?? null,
        population: c.population ?? null,
        lat: c.centre?.coordinates?.[1] ?? null,
        lon: c.centre?.coordinates?.[0] ?? null,
      })));
    }

    if (route === "inscription") {
      // 5 comptes par heure et par IP : suffisant pour une famille, dissuasif pour un robot
      if (!await quota(`inscription:${ip}`, 5, 3600)) return json(TROP_DE_REQUETES, 429);
      if (body.conditions_version !== CONDITIONS_VERSION || body.consentement !== true) {
        return json({
          erreur:
            "vous devez accepter les informations de confidentialité et les limites du service",
          conditions_version: CONDITIONS_VERSION,
        }, 400);
      }
      const { data, error } = await sb.from("abonnes")
        .insert({
          nom: String(body.nom ?? "").slice(0, 60) || null,
          conditions_version: CONDITIONS_VERSION,
          conditions_acceptees_at: new Date().toISOString(),
        })
        .select("id, token, seuil_min, quiet_start, quiet_end").single();
      if (error) throw new Error(error.message);
      return json({ ok: true, abonne: data });
    }

    if (route === "telegram-webhook") {
      // Accuser réception évite les relances automatiques de Telegram tant que
      // l'ancien webhook n'a pas encore été supprimé côté fournisseur.
      return json({
        ok: true,
        actif: false,
        message: "Telegram est temporairement désactivé ; notifications sur appareil uniquement.",
      });
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
          .eq("abonne_id", ab.id)
          .eq("type", "webpush"),
        sb.rpc("detections_abonne", { p_abonne: ab.id, p_heures: 72 }),
        sb.rpc("meteo_abonne", { p_abonne: ab.id }),
      ]);
      return json({
        abonne: {
          id: ab.id,
          nom: ab.nom,
          seuil_min: ab.seuil_min,
          quiet_start: ab.quiet_start,
          quiet_end: ab.quiet_end,
          ref_libelle: ab.ref_libelle ?? null,
          ref_definie: !!ab.ref_geom,
        },
        zones: zones.data ?? [],
        evenements: evts.data ?? [],
        detections: dets.data ?? [],
        canaux: canaux.data ?? [],
        sante: sante.data ?? null,
        meteo: meteo.data ?? {},
        vapid: cfg.vapid_public,
      });
    }

    if (route === "canal") {
      if (body.type !== "webpush") {
        return json({
          erreur: "seules les notifications sur appareil sont disponibles",
        }, 410);
      }
      if (!await quota(`canal:${ab.id}`, 10, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data: place } = await sb.rpc("verifier_plafonds", {
        p_abonne: ab.id,
        p_quoi: "canaux",
      });
      if (!place) return json({ erreur: "maximum de 8 appareils atteint" }, 400);

      const { type, destination, libelle } = body;
      // L'abonnement Web Push est produit par le navigateur : sa destination
      // ne peut donc pas être remplacée par une adresse ou un identifiant tiers.
      const destinationPush = normaliserAbonnementPush(destination);
      if (!destinationPush) return json({ erreur: "abonnement push invalide" }, 400);
      const { data, error } = await sb.from("canaux").upsert({
        abonne_id: ab.id,
        type,
        destination: destinationPush,
        libelle: String(libelle ?? "").slice(0, 40) || null,
        actif: true,
        verifie: true,
        echecs: 0,
        last_error: null,
      }, { onConflict: "abonne_id,type,destination" }).select("id,type,libelle").single();
      if (error) throw new Error(error.message);
      return json({ ok: true, canal: data });
    }

    if (route === "canal-verifier") {
      return json({ erreur: "la vérification e-mail est temporairement désactivée" }, 410);
    }

    if (route === "canal-supprimer") {
      await sb.from("canaux").delete().eq("id", body.id).eq("abonne_id", ab.id);
      return json({ ok: true });
    }

    if (route === "zone") {
      if (!await quota(`zone:${ab.id}`, 15, 3600)) return json(TROP_DE_REQUETES, 429);
      const { data: place } = await sb.rpc("verifier_plafonds", {
        p_abonne: ab.id,
        p_quoi: "zones",
      });
      if (!place) return json({ erreur: "maximum de 10 zones atteint" }, 400);

      const code = String(body.code ?? "").trim();
      if (!/^[0-9][0-9AB][0-9]{3}$/i.test(code)) {
        return json({ erreur: "code INSEE invalide" }, 400);
      }
      if (!await assurerCommune(code)) return json({ erreur: "commune introuvable" }, 404);

      const { data: z, error } = await sb.rpc("upsert_zone", {
        p_code: code,
        p_limitrophes: body.limitrophes !== false,
        p_buffer_m: Math.min(50000, Math.max(0, Number(body.buffer_m ?? 3000) || 0)),
        p_sensibilite: ["sensible", "equilibre", "conservateur"].includes(body.sensibilite)
          ? body.sensibilite
          : "equilibre",
      });
      if (error) throw new Error(error.message);
      const zone = Array.isArray(z) ? z[0] : z;
      await sb.from("zone_abonnes").upsert({ zone_id: zone.id, abonne_id: ab.id });
      return json({
        ok: true,
        zone: { id: zone.id, nom: zone.nom, limitrophes: zone.limitrophes },
      });
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
      if (body.seuil_min && ["info", "alerte", "critique"].includes(body.seuil_min)) {
        maj.seuil_min = body.seuil_min;
      }
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
          p_abonne: ab.id,
          p_lat: lat,
          p_lon: lon,
          p_libelle: String(body.ref_libelle ?? "").slice(0, 40) || null,
        });
        if (error) throw new Error(error.message);
      }

      if (body.zone_id) {
        const zmaj: Record<string, unknown> = {};
        if (["sensible", "equilibre", "conservateur"].includes(body.sensibilite)) {
          zmaj.sensibilite = body.sensibilite;
        }
        if (body.buffer_m != null) {
          zmaj.buffer_m = Math.min(50000, Math.max(0, Number(body.buffer_m) || 0));
        }
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
      // Seuls les abonnements Web Push actifs de l'abonné reçoivent le test.
      const { data: canaux } = await sb.from("canaux")
        .select("id").eq("abonne_id", ab.id).eq("type", "webpush").eq("actif", true).eq(
          "verifie",
          true,
        );
      if (!canaux?.length) return json({ erreur: "aucune notification appareil active" }, 400);

      const faux = {
        zone: "Test",
        commune: "Test",
        dans_commune: true,
        distance_m: 0,
        severite: "info",
        nb_detections: 1,
        frp_max: 12.3,
        sources: ["VIIRS_SNPP"],
        lat: 43.649,
        lon: 1.3197,
        debut_ts: new Date().toISOString(),
        evenement_id: "test",
        message: "Test réussi : cet appareil recevra les alertes incendie.",
      };
      await sb.from("alertes").insert(canaux.map((c) => ({
        canal_id: c.id,
        abonne_id: ab.id,
        type: "test",
        severite: "info",
        statut: "en_attente",
        payload: faux,
      })));
      await declencherDispatch();
      return json({ ok: true, canaux: canaux.length });
    }

    if (route === "compte-exporter") {
      if (!await quota(`export:${ab.id}`, 3, 86400)) return json(TROP_DE_REQUETES, 429);
      const [profil, zones, canaux, signalements, contestations, fiabilite] = await Promise.all([
        sb.from("abonnes").select(
          "id,nom,seuil_min,quiet_start,quiet_end,fuseau,ref_libelle,created_at,last_seen_at,conditions_version,conditions_acceptees_at",
        ).eq("id", ab.id).single(),
        sb.rpc("zones_abonne", { p_abonne: ab.id }),
        sb.from("canaux")
          .select("id,type,destination,libelle,actif,verifie,last_ok_at,last_error,created_at")
          .eq("abonne_id", ab.id),
        sb.from("signalements")
          .select(
            "id,groupe_id,lat,lon,nature,commentaire,ip_hash,commune_code,commune_nom,statut,created_at",
          )
          .eq("abonne_id", ab.id),
        sb.from("signalement_contestations")
          .select("groupe_id,ip_hash,motif,created_at").eq("abonne_id", ab.id),
        sb.rpc("fiabilite_abonne", { p_abonne: ab.id }),
      ]);
      const echec = [profil, zones, canaux, signalements, contestations, fiabilite]
        .find((resultat) => resultat.error);
      if (echec?.error) throw new Error(`export: ${echec.error.message}`);
      return json({
        exporte_at: new Date().toISOString(),
        profil: profil.data,
        zones: zones.data ?? [],
        canaux: canaux.data ?? [],
        signalements: signalements.data ?? [],
        contestations: contestations.data ?? [],
        fiabilite: fiabilite.data ?? {},
      });
    }

    if (route === "compte-supprimer") {
      if (!await quota(`suppression:${ab.id}`, 3, 86400)) return json(TROP_DE_REQUETES, 429);
      if (body.confirmation !== "SUPPRIMER") {
        return json({ erreur: "confirmation SUPPRIMER requise" }, 400);
      }
      const { data, error } = await sb.rpc("supprimer_abonne", { p_abonne: ab.id });
      if (error) throw new Error(error.message);
      return json(data ?? { ok: true });
    }

    return json({ erreur: `route inconnue: ${route}` }, 404);
  } catch (e) {
    console.error("api", route, String(e));
    return json({ erreur: "erreur interne" }, 500);
  }
});
