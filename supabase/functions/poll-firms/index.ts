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
import {
  autoriserOperation,
  CORS,
  empriseFranceEtZones,
  fermerRun,
  fetchRetry,
  json,
  ouvrirRun,
  sb,
} from "../_shared/mod.ts";
import { horodatage, nombreOuNull, normaliserConfiance, parserCsv } from "./parsers.ts";

const BASE = "https://firms.modaps.eosdis.nasa.gov/data/active_fire";

const FLUX = [
  {
    source: "VIIRS_SNPP",
    res: 375,
    url: `${BASE}/suomi-npp-viirs-c2/csv/SUOMI_VIIRS_C2_Europe_24h.csv`,
  },
  {
    source: "VIIRS_NOAA20",
    res: 375,
    url: `${BASE}/noaa-20-viirs-c2/csv/J1_VIIRS_C2_Europe_24h.csv`,
  },
  {
    source: "VIIRS_NOAA21",
    res: 375,
    url: `${BASE}/noaa-21-viirs-c2/csv/J2_VIIRS_C2_Europe_24h.csv`,
  },
  { source: "MODIS", res: 1000, url: `${BASE}/c6.1/csv/MODIS_C6_1_Europe_24h.csv` },
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!await autoriserOperation(req, "poll-firms")) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-firms");
  const stats: Record<string, any> = { flux: {} };

  try {
    // 1. Emprise à surveiller
    const { data: bbox, error: eb } = await sb.rpc("bbox_surveillance", { p_marge_deg: 0.05 });
    if (eb) throw new Error(`bbox: ${eb.message}`);
    const emprise = empriseFranceEtZones(bbox);
    stats.emprise = emprise;

    // 2. Téléchargement + filtrage des 4 flux, en parallèle
    const lots = await Promise.all(FLUX.map(async (f) => {
      try {
        // Reessais : les serveurs NASA rendent regulierement des 5xx
        // passagers, et un seul essai transforme un hoquet de trois
        // secondes en creneau de collecte perdu.
        const r = await fetchRetry(
          f.url,
          {
            headers: { "User-Agent": "alerte-incendie/1.0 (surveillance communale)" },
          },
          3,
          30_000,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const lignes = parserCsv(await r.text());

        const retenues = [];
        for (const l of lignes) {
          const lat = Number(l.latitude), lon = Number(l.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (
            lat < emprise.sud || lat > emprise.nord ||
            lon < emprise.ouest || lon > emprise.est
          ) continue;

          retenues.push({
            source: f.source,
            acq_ts: horodatage(l.acq_date, l.acq_time),
            lat,
            lon,
            geom: `SRID=4326;POINT(${lon} ${lat})`,
            confiance: (l.confidence ?? "").trim(),
            confiance_num: normaliserConfiance(l.confidence),
            // `Number(x) || null` transformait une FRP de 0 en null : rare,
            // mais 0 MW est une mesure, pas une absence de mesure.
            frp: nombreOuNull(l.frp),
            brillance: nombreOuNull(l.bright_ti4 ?? l.brightness),
            daynight: (l.daynight ?? "").trim().slice(0, 1) || null,
            resolution_m: f.res,
            fingerprint: `${f.source}|${lat.toFixed(5)}|${
              lon.toFixed(5)
            }|${l.acq_date}|${l.acq_time}`,
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
