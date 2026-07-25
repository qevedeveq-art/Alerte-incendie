// =====================================================================
//  poll-firms — moteur de surveillance
// ---------------------------------------------------------------------
//  Interroge les 4 flux « Active Fire » de NASA FIRMS couvrant l'Europe.
//  Ces fichiers régionaux ne demandent aucune clé API, contrairement à
//  l'API /api/area — d'où le choix de cette source : rien à renouveler,
//  rien à surveiller côté quota.
//
//    VIIRS S-NPP    375 m
//    VIIRS NOAA-20  375 m
//    VIIRS NOAA-21  375 m
//    MODIS C6.1    1000 m
//
//  Chaîne de traitement :
//    1. emprise des zones actives (une seule requête PostGIS)
//    2. téléchargement des 4 flux en parallèle, filtrage sur l'emprise
//    3. insertion dédoublonnée (empreinte unique par détection)
//    4. apprentissage des sources thermiques permanentes
//    5. agrégation spatio-temporelle en évènements + calcul de sévérité
//    6. déclenchement de l'envoi des alertes
//
//  Cadence : toutes les 10 minutes (cron pg_cron). Inutile d'aller plus
//  vite, les fichiers amont sont régénérés environ une fois par heure.
// =====================================================================
import { fermerRun, json, CORS, estInterne, ouvrirRun, sb, verifierAdmin } from "../_shared/mod.ts";

const BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";

const FLUX = [
  { source: "VIIRS_SNPP",   res: 375,  url: `${BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv` },
  { source: "VIIRS_NOAA20", res: 375,  url: `${BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv` },
  { source: "VIIRS_NOAA21", res: 375,  url: `${BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv` },
  { source: "MODIS",        res: 1000, url: `${BASE}/c6.1/csv/MODIS_C6_1_Europe_24h.csv` },
];

/** VIIRS renvoie low/nominal/high, MODIS un pourcentage : on normalise sur 0-100. */
function normaliserConfiance(v: string): number | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "l" || t === "low") return 20;
  if (t === "n" || t === "nominal") return 60;
  if (t === "h" || t === "high") return 90;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** acq_date=2026-07-24 + acq_time=0030 (UTC) -> 2026-07-24T00:30:00Z */
function horodatage(date: string, time: string): string {
  const t = String(time ?? "0").trim().padStart(4, "0");
  return `${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
}

function parserCsv(txt: string): Record<string, string>[] {
  const lignes = txt.trim().split("\n");
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(",").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lignes.length; i++) {
    const cols = lignes[i].split(",");
    if (cols.length < entetes.length) continue;
    const o: Record<string, string> = {};
    entetes.forEach((h, j) => (o[h] = cols[j]));
    out.push(o);
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!estInterne(req) && !await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-firms");
  const stats: Record<string, any> = { flux: {} };

  try {
    // 1. Emprise à surveiller
    const { data: bbox, error: eb } = await sb.rpc("bbox_surveillance", { p_marge_deg: 0.05 });
    if (eb) throw new Error(`bbox: ${eb.message}`);
    if (!bbox) {
      await fermerRun(runId, true, { note: "aucune zone active" });
      return json({ ok: true, note: "aucune zone active" });
    }

    // 2. Téléchargement + filtrage des 4 flux, en parallèle
    const lots = await Promise.all(FLUX.map(async (f) => {
      try {
        const r = await fetch(f.url, {
          signal: AbortSignal.timeout(30_000),
          headers: { "User-Agent": "alerte-incendie/1.0 (surveillance communale)" },
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const lignes = parserCsv(await r.text());

        const retenues = [];
        for (const l of lignes) {
          const lat = Number(l.latitude), lon = Number(l.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (lat < bbox.sud || lat > bbox.nord || lon < bbox.ouest || lon > bbox.est) continue;

          retenues.push({
            source: f.source,
            acq_ts: horodatage(l.acq_date, l.acq_time),
            lat, lon,
            geom: `SRID=4326;POINT(${lon} ${lat})`,
            confiance: (l.confidence ?? "").trim(),
            confiance_num: normaliserConfiance(l.confidence),
            frp: Number(l.frp) || null,
            brillance: Number(l.bright_ti4 ?? l.brightness) || null,
            daynight: (l.daynight ?? "").trim().slice(0, 1) || null,
            resolution_m: f.res,
            fingerprint: `${f.source}|${lat.toFixed(5)}|${lon.toFixed(5)}|${l.acq_date}|${l.acq_time}`,
          });
        }
        stats.flux[f.source] = { lignes: lignes.length, retenues: retenues.length };
        return retenues;
      } catch (e) {
        stats.flux[f.source] = { erreur: String(e) };
        return [];
      }
    }));

    const toutes = lots.flat();
    stats.total_retenu = toutes.length;

    // Si aucun flux ne répond, le run est en échec : le heartbeat le verra
    // et prévient l'abonné plutôt que de laisser le système muet.
    const fluxOk = Object.values(stats.flux).filter((f: any) => !f.erreur).length;
    if (fluxOk === 0) throw new Error("aucun flux satellite joignable");
    stats.flux_ok = fluxOk;

    // 3. Insertion dédoublonnée
    let inserees = 0;
    for (let i = 0; i < toutes.length; i += 200) {
      const { data, error } = await sb.from("detections")
        .upsert(toutes.slice(i, i + 200), { onConflict: "fingerprint", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`insert: ${error.message}`);
      inserees += data?.length ?? 0;
    }
    stats.nouvelles_detections = inserees;

    // 4 & 5. Sources permanentes, puis agrégation en évènements
    const { data: nbPerm } = await sb.rpc("apprendre_sources_permanentes");
    stats.detections_ecartees_permanentes = nbPerm ?? 0;

    const { data: agg, error: ea } = await sb.rpc("traiter_detections");
    if (ea) throw new Error(`traiter: ${ea.message}`);
    stats.agregation = agg;

    // 6. Vidage de la file d'alertes
    const { count } = await sb.from("alertes")
      .select("id", { count: "exact", head: true }).eq("statut", "en_attente");
    stats.alertes_en_attente = count ?? 0;

    if ((count ?? 0) > 0) {
      const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/dispatch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
        body: JSON.stringify({ interne: true }),
      });
      stats.dispatch = r.ok ? await r.json().catch(() => "ok") : `HTTP ${r.status}`;
    }

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
