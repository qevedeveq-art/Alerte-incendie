// =====================================================================
//  signalement — signalements citoyens de départ de feu
// ---------------------------------------------------------------------
//  Troisième niveau de détection du système :
//
//    citoyen         instantané    très précis    non vérifié
//    géostationnaire ~25 min       3 km           automatique
//    polaire         2-3 h         375 m          automatique
//
//  Un signalement confirmé déclenche une alerte de sévérité 'alerte',
//  explicitement étiquetée non vérifiée. Elle n'atteint 'critique' que
//  si un satellite corrobore au même endroit — dans un sens comme dans
//  l'autre.
//
//  Règle de confirmation : 2 personnes sur 2 réseaux distincts, OU
//  3 personnes quel que soit le réseau. Exiger deux réseaux seulement
//  aurait bloqué deux voisins partageant une box, et surtout les
//  abonnés mobiles derrière le NAT d'opérateur — or les deux premiers
//  témoins d'un feu sont probablement voisins.
//
//  Pourquoi tant de garde-fous : sur un service d'alerte, quelques faux
//  positifs suffisent à ce que les gens cessent de croire aux vraies
//  alertes. Le risque n'est pas le spam, c'est la perte de confiance.
//
//    POST /signalement          { lat, lon, nature, commentaire }  x-token
//    GET  /signalement/carte    couche publique, 24 h par défaut
// =====================================================================
import { sb, json, CORS, ipAppelant, quota, TROP_DE_REQUETES } from "../_shared/mod.ts";

const NATURES = ["fumee", "flammes", "odeur", "autre"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/signalement\/?/, "").replace(/\/$/, "");
  const ip = ipAppelant(req);

  try {
    // ---------- couche carte, publique ----------
    if (req.method === "GET" || route === "carte") {
      if (!await quota(`sig-carte:${ip}`, 120, 60)) return json(TROP_DE_REQUETES, 429);
      const heures = Math.min(72, Math.max(1, Number(url.searchParams.get("heures") ?? 24) || 24));
      const { data, error } = await sb.rpc("signalements_carte", { p_heures: heures });
      if (error) throw new Error(error.message);
      return json({ ok: true, heures, signalements: data ?? [] });
    }

    // ---------- création, jeton requis ----------
    const jeton = req.headers.get("x-token") ?? "";
    if (jeton.length < 32 || jeton.length > 128) return json({ erreur: "jeton invalide" }, 401);
    const { data: ab } = await sb.from("abonnes")
      .select("id, actif").eq("token", jeton).maybeSingle();
    if (!ab || !ab.actif) return json({ erreur: "jeton invalide" }, 401);

    // Quotas : 3 signalements par heure et par personne, 6 par réseau.
    // Généreux pour un témoin de bonne foi, contraignant pour un robot.
    if (!await quota(`sig:${ab.id}`, 3, 3600)) {
      return json({ erreur: "vous avez atteint la limite de 3 signalements par heure" }, 429);
    }
    if (!await quota(`sig-ip:${ip}`, 6, 3600)) return json(TROP_DE_REQUETES, 429);

    const body = await req.json().catch(() => ({} as any));
    const lat = Number(body.lat), lon = Number(body.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return json({ erreur: "coordonnées invalides" }, 400);
    }
    // Emprise France métropolitaine et outre-mer, large : hors de là, c'est
    // forcément une erreur de saisie ou un abus.
    const dansPerimetre =
      (lat > 41 && lat < 51.5 && lon > -5.5 && lon < 10) ||   // métropole
      (lat > 41 && lat < 43.1 && lon > 8.4 && lon < 9.6) ||   // Corse
      (lat > -21.5 && lat < 16.6 && lon > -63 && lon < 56);   // outre-mer
    if (!dansPerimetre) return json({ erreur: "position hors zone couverte" }, 400);

    const nature = NATURES.includes(body.nature) ? body.nature : "fumee";
    const commentaire = String(body.commentaire ?? "").trim().slice(0, 280) || null;

    const { data, error } = await sb.rpc("enregistrer_signalement", {
      p_abonne: ab.id,
      p_lat: Math.round(lat * 1e5) / 1e5,
      p_lon: Math.round(lon * 1e5) / 1e5,
      p_nature: nature,
      p_commentaire: commentaire,
      p_ip: ip,
    });
    if (error) throw new Error(error.message);

    // Un signalement confirmé peut avoir créé un évènement à notifier
    if (data?.confirme) {
      fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ interne: true }),
      }).catch(() => {});
    }

    return json({
      ...data,
      rappel: "Si vous voyez un départ de feu, appelez le 18 ou le 112. " +
        "Ce signalement ne prévient pas les secours.",
    });
  } catch (e) {
    console.error("signalement", route, String(e));
    return json({ erreur: "erreur interne" }, 500);
  }
});
