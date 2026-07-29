// =====================================================================
//  probe-sentinel3 — veille sur Sentinel-3 SLSTR FRP NRT
// ---------------------------------------------------------------------
//  La documentation CDSE annonce la collection FRP NRT, mais le catalogue
//  STAC public doit exposer un identifiant stable avant toute ingestion.
//  Cette sonde cherche la collection sans inventer d'URL ni de schema.
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

const COLLECTIONS = "https://stac.dataspace.copernicus.eu/v1/collections";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erreur: "méthode non autorisée" }, 405);
  if (!await autoriserOperation(req, "probe-sentinel3")) {
    return json({ erreur: "non autorisé" }, 401);
  }

  const runId = await ouvrirRun("probe-sentinel3");
  const stats: Record<string, unknown> = {};
  try {
    const r = await fetchRetry(
      COLLECTIONS,
      {
        headers: { "User-Agent": "alerte-incendie/1.0" },
      },
      2,
      20_000,
    );
    if (!r.ok) throw new Error(`catalogue STAC HTTP ${r.status}`);
    const catalogue = await r.json();
    const collections = Array.isArray(catalogue?.collections) ? catalogue.collections : [];
    const candidates = collections.filter((c: Record<string, unknown>) => {
      const texte = `${c.id ?? ""} ${c.title ?? ""} ${c.description ?? ""}`.toLowerCase();
      return (texte.includes("sentinel-3") || texte.includes("slstr")) &&
        (texte.includes("fire radiative") || texte.includes("frp"));
    }).map((c: Record<string, unknown>) => ({
      id: String(c.id ?? ""),
      titre: String(c.title ?? ""),
    }));

    const disponible = candidates.length > 0;
    Object.assign(stats, {
      verifie_le: new Date().toISOString(),
      endpoint: COLLECTIONS,
      collection_exposee: disponible,
      candidates,
      verdict: disponible ? "collection_stable_a_evaluer" : "non_exposee_dans_stac",
    });
    await sb.from("config").upsert({
      k: "sentinel3_veille",
      v: stats,
      updated_at: new Date().toISOString(),
    }, { onConflict: "k" });
    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
