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
//    POST /signalement/contester { groupe_id, motif }               x-token
//    GET  /signalement/carte    couche publique, 24 h par défaut
//    GET  /signalement/mes-signalements historique privé            x-token
// =====================================================================
import { CORS, ipAppelant, json, quota, sb, TROP_DE_REQUETES } from "../_shared/mod.ts";
import { aUnCanalVerifie } from "../_shared/format.ts";

const NATURES = ["fumee", "flammes", "odeur", "autre"];
const INTENSITES = ["faible", "moyenne", "forte"];
const VEGETATIONS = ["foret", "broussailles", "herbes", "culture", "inconnue"];
const CERTITUDES = ["incertain", "probable", "certain"];
const DETAIL_OPERATIONNEL =
  /(?:position|coordonn[ée]es?|mouvement|trajet|strat[ée]gie).{0,40}(?:secours|pompier|canadair|dash|h[ée]licopt[èe]re)|(?:secours|pompier|canadair|dash|h[ée]licopt[èe]re).{0,40}(?:position|coordonn[ée]es?|mouvement|trajet|strat[ée]gie)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/signalement\/?/, "").replace(/\/$/, "");
  const ip = ipAppelant(req);

  try {
    // ---------- couche carte, publique ----------
    if (req.method === "GET" && (route === "" || route === "carte")) {
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

    const { data: canaux, error: erreurCanaux } = await sb.from("canaux")
      .select("actif, verifie")
      .eq("abonne_id", ab.id);
    if (erreurCanaux) throw new Error(erreurCanaux.message);
    if (!aUnCanalVerifie(canaux)) {
      return json({
        erreur:
          "compte non vérifié : activez et vérifiez une notification Push, Telegram ou e-mail avant de contribuer",
      }, 403);
    }

    if (req.method === "GET" && route === "mes-signalements") {
      if (!await quota(`mes-signalements:${ab.id}`, 30, 60)) {
        return json(TROP_DE_REQUETES, 429);
      }
      const { data, error } = await sb.rpc("mes_signalements", {
        p_abonne: ab.id,
        p_limite: 50,
      });
      if (error) throw new Error(error.message);
      return json({ ok: true, signalements: data ?? [] });
    }

    if (route === "contester") {
      if (!await quota(`sig-conteste:${ab.id}`, 10, 3600)) {
        return json({ erreur: "limite de contestations atteinte" }, 429);
      }
      if (!await quota(`sig-conteste-ip:${ip}`, 20, 3600)) {
        return json(TROP_DE_REQUETES, 429);
      }
      const body = await req.json().catch(() => ({} as any));
      const groupeId = String(body.groupe_id ?? "");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(groupeId)
      ) {
        return json({ erreur: "signalement invalide" }, 400);
      }
      const { data, error } = await sb.rpc("contester_signalement", {
        p_abonne: ab.id,
        p_groupe: groupeId,
        p_ip: ip,
        p_motif: String(body.motif ?? "").slice(0, 160) || null,
      });
      if (error) throw new Error(error.message);
      if (data?.ok === false) return json(data, 400);
      return json(data ?? { ok: true });
    }

    // Quotas : 3 signalements par heure et par personne, 6 par réseau.
    // Généreux pour un témoin de bonne foi, contraignant pour un robot.
    if (!await quota(`sig:${ab.id}`, 3, 3600)) {
      return json({ erreur: "vous avez atteint la limite de 3 signalements par heure" }, 429);
    }
    if (!await quota(`sig-ip:${ip}`, 6, 3600)) return json(TROP_DE_REQUETES, 429);

    const body = await req.json().catch(() => ({} as any));
    const lat = Number(body.lat), lon = Number(body.lon);
    if (
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180
    ) {
      return json({ erreur: "coordonnées invalides" }, 400);
    }
    // Emprise France métropolitaine et outre-mer, large : hors de là, c'est
    // forcément une erreur de saisie ou un abus.
    const dansPerimetre = (lat > 41 && lat < 51.5 && lon > -5.5 && lon < 10) || // métropole
      (lat > 41 && lat < 43.1 && lon > 8.4 && lon < 9.6) || // Corse
      (lat > -21.5 && lat < 16.6 && lon > -63 && lon < 56); // outre-mer
    if (!dansPerimetre) return json({ erreur: "position hors zone couverte" }, 400);

    const nature = NATURES.includes(body.nature) ? body.nature : "fumee";
    const commentaire = String(body.commentaire ?? "").trim().slice(0, 280) || null;
    if (commentaire && DETAIL_OPERATIONNEL.test(commentaire)) {
      return json({
        erreur: "ne publiez pas la position, les mouvements ou la stratégie des secours",
      }, 400);
    }

    const intensite = INTENSITES.includes(body.intensite_percue) ? body.intensite_percue : null;
    const vegetation = VEGETATIONS.includes(body.vegetation) ? body.vegetation : null;
    const certitude = CERTITUDES.includes(body.certitude) ? body.certitude : null;
    const observeAt = new Date(body.observe_at ?? Date.now());
    const maintenant = Date.now();
    if (
      !Number.isFinite(observeAt.getTime()) ||
      observeAt.getTime() < maintenant - 12 * 3_600_000 ||
      observeAt.getTime() > maintenant + 15 * 60_000
    ) {
      return json({ erreur: "heure d'observation invalide ou trop ancienne" }, 400);
    }

    const { data, error } = await sb.rpc("enregistrer_signalement", {
      p_abonne: ab.id,
      p_lat: Math.round(lat * 1e5) / 1e5,
      p_lon: Math.round(lon * 1e5) / 1e5,
      p_nature: nature,
      p_commentaire: commentaire,
      p_ip: ip,
    });
    if (error) throw new Error(error.message);

    if (data?.signalement_id) {
      const { error: erreurStructure } = await sb.from("signalements").update({
        observe_at: observeAt.toISOString(),
        intensite_percue: intensite,
        vegetation,
        proximite_habitations: body.proximite_habitations === true,
        certitude,
      }).eq("id", data.signalement_id).eq("abonne_id", ab.id);
      if (erreurStructure) throw new Error(erreurStructure.message);
    }

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
