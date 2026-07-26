// =====================================================================
//  probe-mtg — veille automatique sur Meteosat 3e generation
// ---------------------------------------------------------------------
//  MTG FRP-Pixel a ete evalue le 25/07/2026 puis ECARTE : sur le papier
//  1 km de resolution et 10 minutes de cadence, mais en pratique le
//  repertoire s'arretait a la veille alors que MSG etait a jour a la
//  demi-heure. Le produit est publie par lots quotidiens et porte le
//  statut « Demonstration ».
//
//  Le probleme n'est pas ce verdict, il est juste. Le probleme est
//  qu'une note dans un document ne se relit jamais. Si MTG passe
//  operationnel, le seuil de detection tomberait de ~20 MW a bien
//  moins, et la resolution de 3 km a 1 km : c'est le gain le plus
//  important encore disponible, et on le manquerait.
//
//  Cette fonction teste donc la fraicheur du repertoire une fois par
//  mois et enregistre son verdict dans config.mtg_veille. A consulter :
//
//    select v from public.config where k = 'mtg_veille';
//    select stats, started_at from public.runs
//     where kind = 'probe-mtg' order by started_at desc limit 6;
// =====================================================================
import {
  config,
  CORS,
  estInterne,
  fermerRun,
  fetchRetry,
  json,
  ouvrirRun,
  sb,
  verifierAdmin,
} from "../_shared/mod.ts";

const BASE = "https://datalsasaf.lsasvcs.ipma.pt/PRODUCTS/MTG/MTFRPPixel/NATIVE";

/** Les listings du serveur sont du HTML Apache : on en extrait les hrefs. */
function entrees(html: string): string[] {
  return [...html.matchAll(/href="([^"?][^"]*)"/g)]
    .map((m) => m[1].replace(/\/$/, ""))
    .filter((h) => /^[\w.-]+$/.test(h));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!estInterne(req) && !await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("probe-mtg");
  const stats: Record<string, any> = {};

  try {
    const cfg = await config();
    const ident = (cfg.lsasaf ?? {}) as Record<string, any>;
    const entetes: Record<string, string> = { "User-Agent": "alerte-incendie/1.0" };
    if (ident.utilisateur && ident.motdepasse) {
      entetes.Authorization = "Basic " + btoa(`${ident.utilisateur}:${ident.motdepasse}`);
    }

    const maintenant = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const AAAA = maintenant.getUTCFullYear();
    const MM = p(maintenant.getUTCMonth() + 1);

    const r = await fetchRetry(`${BASE}/${AAAA}/${MM}/`, { headers: entetes }, 2, 20_000);
    if (!r.ok) throw new Error(`listing HTTP ${r.status}`);

    const jours = entrees(await r.text())
      .filter((x) => /^\d{2}$/.test(x))
      .sort();
    const dernierJour = jours.at(-1) ?? null;
    stats.mois = `${AAAA}-${MM}`;
    stats.dernier_jour_publie = dernierJour;

    if (!dernierJour) throw new Error("aucun jour publié dans le répertoire du mois");

    // Retard, en jours, entre aujourd'hui (UTC) et le dernier jour publie.
    const retardJours = maintenant.getUTCDate() - Number(dernierJour);
    stats.retard_jours = retardJours;

    // Fraicheur intra-journaliere : combien de creneaux pour ce jour ?
    let creneaux = 0, dernierCreneau: string | null = null;
    try {
      const rj = await fetchRetry(`${BASE}/${AAAA}/${MM}/${dernierJour}/`, {
        headers: entetes,
      }, 2, 20_000);
      if (rj.ok) {
        const fichiers = entrees(await rj.text()).filter((x) => /\d{12}/.test(x));
        creneaux = fichiers.length;
        dernierCreneau = fichiers.sort().at(-1)?.match(/(\d{12})/)?.[1] ?? null;
      }
    } catch { /* le detail du jour est un bonus, pas un prerequis */ }
    stats.creneaux_du_jour = creneaux;
    stats.dernier_creneau = dernierCreneau;

    // Verdict : temps reel si le jour courant est publie et bien rempli.
    const tempsReel = retardJours <= 0 && creneaux >= 24;
    const verdict = tempsReel
      ? "temps_reel"
      : retardJours <= 1
      ? "quasi_quotidien"
      : "lots_quotidiens";
    stats.verdict = verdict;

    if (tempsReel) {
      stats.recommandation =
        "MTG semble desormais publie en continu. Resolution 1 km et cadence 10 min : " +
        "envisager de l'ajouter comme troisieme source satellite, le seuil de detection " +
        "tomberait nettement sous les ~20 MW de MSG.";
    }

    await sb.from("config").upsert({
      k: "mtg_veille",
      v: {
        verifie_le: maintenant.toISOString(),
        verdict,
        retard_jours: retardJours,
        creneaux_du_jour: creneaux,
        dernier_creneau: dernierCreneau,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "k" });

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
