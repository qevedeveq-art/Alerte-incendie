// =====================================================================
//  poll-adsb — corroboration par les aeronefs de lutte
// ---------------------------------------------------------------------
//  Source : OpenSky Network (https://opensky-network.org), gratuit pour
//  un usage non commercial. L'acces anonyme est fortement limite en
//  cadence ; un compte gratuit releve nettement le plafond.
//
//  Principe : un bombardier d'eau qui tourne a basse altitude au-dessus
//  d'un point confirme un feu reel et significatif, souvent avant le
//  passage satellite polaire suivant. On ne cree jamais d'evenement a
//  partir de ce signal seul (transit, entrainement, mission sanitaire) :
//  il ne fait que corroborer un evenement deja actif a proximite.
//
//  DESACTIVE PAR DEFAUT. Tant que `config.adsb` n'est pas renseigne et
//  actif, la fonction ne fait rien et se termine en succes.
//
//    update public.config set v = jsonb_build_object(
//      'actif', true,
//      'utilisateur', 'XXX',     -- facultatif (compte OpenSky)
//      'motdepasse',  'YYY',
//      'indicatifs', array['PELICAN','MILAN','DRAGON','MORANE'])
//    where k = 'adsb';
// =====================================================================
import {
  autoriserOperation,
  config,
  CORS,
  fermerRun,
  fetchRetry,
  json,
  ouvrirRun,
  sb,
} from "../_shared/mod.ts";

const API = "https://opensky-network.org/api/states/all";

// Indicatifs par defaut de la Securite civile francaise et de ses
// prestataires. Surchargeable par configuration : la flotte change.
const INDICATIFS_DEFAUT = ["PELICAN", "MILAN", "DRAGON", "MORANE", "BOMBARDIER"];

// Un appareil en lutte travaille bas. Au-dela, c'est un transit.
const ALT_MAX_M = 1800;

/** Un etat OpenSky est un tableau positionnel, pas un objet. */
function lireEtat(s: unknown[]) {
  return {
    icao24: String(s[0] ?? "").trim(),
    indicatif: String(s[1] ?? "").trim(),
    lon: Number(s[5]),
    lat: Number(s[6]),
    auSol: Boolean(s[8]),
    vitesse: Number(s[9]),
    altitude: Number(s[13] ?? s[7]),
    vu: Number(s[4] ?? s[3]),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erreur: "méthode non autorisée" }, 405);
  if (!await autoriserOperation(req, "poll-adsb")) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-adsb");
  const stats: Record<string, any> = {};

  try {
    const cfg = await config();
    const a = (cfg.adsb ?? {}) as Record<string, any>;
    if (!a.actif) {
      await fermerRun(runId, true, { note: "source désactivée" });
      return json({ ok: true, note: "config.adsb inactif" });
    }

    const { data: bbox, error: eb } = await sb.rpc("bbox_surveillance", { p_marge_deg: 0.15 });
    if (eb) throw new Error(`bbox: ${eb.message}`);
    if (!bbox) {
      await fermerRun(runId, true, { note: "aucune zone active" });
      return json({ ok: true, note: "aucune zone active" });
    }

    const url = `${API}?lamin=${bbox.sud}&lomin=${bbox.ouest}` +
      `&lamax=${bbox.nord}&lomax=${bbox.est}`;
    const entetes: Record<string, string> = { "User-Agent": "alerte-incendie/1.0" };
    if (a.utilisateur && a.motdepasse) {
      entetes.Authorization = "Basic " + btoa(`${a.utilisateur}:${a.motdepasse}`);
    }

    const r = await fetchRetry(url, { headers: entetes }, 2, 20_000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const etats: unknown[][] = Array.isArray(j?.states) ? j.states : [];
    stats.aeronefs_dans_emprise = etats.length;

    const motifs: string[] =
      (Array.isArray(a.indicatifs) && a.indicatifs.length ? a.indicatifs : INDICATIFS_DEFAUT).map((
        x: string,
      ) => String(x).toUpperCase());

    const lignes = [];
    for (const brut of etats) {
      const e = lireEtat(brut);
      if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
      if (e.auSol) continue;
      if (Number.isFinite(e.altitude) && e.altitude > ALT_MAX_M) continue;
      if (!motifs.some((m) => e.indicatif.toUpperCase().startsWith(m))) continue;

      // Arrondi a la minute : evite d'empiler dix positions identiques
      // quand la fonction est rejouee.
      const vu = new Date((Number.isFinite(e.vu) ? e.vu : Date.now() / 1000) * 1000);
      vu.setSeconds(0, 0);

      lignes.push({
        icao24: e.icao24,
        indicatif: e.indicatif || null,
        vu_at: vu.toISOString(),
        geom: `SRID=4326;POINT(${e.lon} ${e.lat})`,
        altitude_m: Number.isFinite(e.altitude) ? Math.round(e.altitude) : null,
        vitesse_kmh: Number.isFinite(e.vitesse) ? Math.round(e.vitesse * 3.6) : null,
        fingerprint: `${e.icao24}|${vu.toISOString()}`,
      });
    }
    stats.aeronefs_de_lutte = lignes.length;

    if (lignes.length) {
      const { error } = await sb.from("observations_aero")
        .upsert(lignes, { onConflict: "fingerprint", ignoreDuplicates: true });
      if (error) throw new Error(`insert: ${error.message}`);

      const { data: corr, error: ec } = await sb.rpc("corroborer_par_aeronefs");
      if (ec) throw new Error(`corroboration: ${ec.message}`);
      stats.corroboration = corr;
    }

    const { data: purgees, error: ep } = await sb.rpc("purger_aero");
    if (ep) throw new Error(`purge: ${ep.message}`);
    stats.observations_purgees = purgees ?? 0;

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
