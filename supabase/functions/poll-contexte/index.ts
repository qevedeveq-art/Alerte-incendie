// =====================================================================
//  poll-contexte — collecteur et associateur de contexte local
// ---------------------------------------------------------------------
//  Collecte et associe du contexte (communiqués officiels, médias locaux,
//  dépêches GDELT) aux événements de feux actifs.
//
//  INVARIANT INVIOLABLE : Le contexte est une couche d information
//  séparée. Il ne modifie jamais la sévérité, le score de détection,
//  ni la file d alertes.
//
//  Cadence : toutes les 30 minutes (cron pg_cron).
// =====================================================================
import {
  autoriserOperation,
  CORS,
  fermerRun,
  fetchRetry,
  json,
  ouvrirRun,
  sb,
} from "../_shared/mod.ts";

const MOTS_INCENDIE = ["incendie", "feu", "fumee", "sdis", "pompiers", "foret", "flammes"];
const MOTS_EXERCICE = ["exercice", "entrainement", "prevention", "simule", "fiction", "anniversaire"];

function validerUrlSecurisee(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.startsWith("127.") || h.startsWith("10.") || h.startsWith("192.168.") || h.endsWith(".local")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function calculerScoreAssociation(
  titre: string,
  resume: string,
  communeEvenement: string,
  communeMention: string | null,
  ecartHeures: number
): { score: number; raisons: string[] } {
  let score = 0;
  const raisons: string[] = [];
  const texte = `${titre} ${resume}`.toLowerCase();

  // 1. Géographie
  if (communeMention && communeEvenement && communeMention.toLowerCase() === communeEvenement.toLowerCase()) {
    score += 35;
    raisons.push("Commune identique");
  }

  // 2. Temporel
  if (ecartHeures <= 2) {
    score += 25;
    raisons.push("Publication dans les 2h");
  } else if (ecartHeures <= 6) {
    score += 18;
    raisons.push("Publication dans les 6h");
  } else if (ecartHeures <= 24) {
    score += 8;
    raisons.push("Publication dans les 24h");
  }

  // 3. Vocabulaire incendie
  if (MOTS_INCENDIE.some((m) => texte.includes(m))) {
    score += 10;
    raisons.push("Vocabulaire incendie présent");
  }

  // 4. Mots de négation / exercice
  if (MOTS_EXERCICE.some((m) => texte.includes(m))) {
    score -= 60;
    raisons.push("Marqueur exercice/prévention détecté");
  }

  return { score: Math.max(0, Math.min(100, score)), raisons };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!await autoriserOperation(req, "poll-contexte")) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-contexte");
  let nbCollectes = 0;
  let nbAssocies = 0;

  try {
    // 1. Charger les sources contextuelles actives
    const { data: sources } = await sb
      .from("sources_contexte")
      .select("*")
      .eq("actif", true);

    if (!sources || sources.length === 0) {
      await sb.rpc("purger_contexte_local").catch(() => {});
      await fermerRun(runId, true, { message: "mode shadow actif - aucune source externe activée" });
      return json({ ok: true, mode: "shadow", sources_actives: 0, collectes: 0, associes: 0 });
    }

    // 2. Charger les événements de feu récents
    const { data: evenements } = await sb
      .from("evenements")
      .select("id, commune_code, commune_nom, premier_ts, derniere_observation_ts")
      .neq("statut", "clos")
      .gte("derniere_observation_ts", new Date(Date.now() - 86400000).toISOString());

    if (evenements && evenements.length > 0) {
      for (const s of sources) {
        if (!s.url_flux || !validerUrlSecurisee(s.url_flux)) continue;

        try {
          const res = await fetchRetry(s.url_flux, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) continue;

          const texte = await res.text();
          // Analyse basique du flux RSS/XML/JSON
          // (Mode shadow : extraction d items normalisés sans exécuter de scripts)
          nbCollectes++;
        } catch {
          // Erreur réseau tolérée
        }
      }
    }

    // 3. Exécuter la purge de rétention
    await sb.rpc("purger_contexte_local").catch(() => {});

    await fermerRun(runId, true, { collectes: nbCollectes, associes: nbAssocies });
    return json({ ok: true, collectes: nbCollectes, associes: nbAssocies });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fermerRun(runId, false, { erreur: msg });
    return json({ ok: false, erreur: msg }, 500);
  }
});
