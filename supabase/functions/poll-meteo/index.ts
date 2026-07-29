// =====================================================================
//  poll-meteo — vent, humidite, temperature par zone surveillee
// ---------------------------------------------------------------------
//  Source : Open-Meteo (https://open-meteo.com), gratuit, sans cle,
//  serveurs en UE, licence CC BY 4.0 pour un usage non commercial.
//
//  Deux usages, tous deux absents jusqu'ici :
//
//  1. RENDRE L'ALERTE ACTIONNABLE. « Feu a 4 km » ne dit pas s'il vient
//     vers vous. Le vent, lui, le dit. C'est l'information qui manquait
//     le plus au message d'alerte.
//
//  2. MODULER LA SENSIBILITE. Le profil de detection etait fige par
//     zone, alors que le compromis faux positifs / detection tardive
//     n'a pas le meme cout un jour humide et sans vent qu'un jour a
//     35 degres avec des rafales a 50 km/h.
//
//  La modulation est asymetrique : elle ne peut que durcir la
//  detection, jamais l'assouplir (voir sensibilite_effective).
//  Assouplir un seuil sur la foi d'une prevision meteo reviendrait a
//  masquer un depart de feu reel.
//
//  Cadence : deux fois par heure. Les variables evoluent lentement et
//  l'API est limitee en volume.
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

const API = "https://api.open-meteo.com/v1/forecast";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erreur: "méthode non autorisée" }, 405);
  if (!await autoriserOperation(req, "poll-meteo")) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-meteo");
  const stats: Record<string, any> = { zones: {} };

  try {
    const { data: zones, error } = await sb.rpc("zones_a_meteo");
    if (error) throw new Error(`zones: ${error.message}`);
    if (!zones?.length) {
      await fermerRun(runId, true, { note: "aucune zone active" });
      return json({ ok: true, note: "aucune zone active" });
    }

    let ok = 0;
    for (const z of zones as Array<{ zone_id: string; lat: number; lon: number }>) {
      try {
        const url = `${API}?latitude=${z.lat.toFixed(4)}&longitude=${z.lon.toFixed(4)}` +
          `&current=temperature_2m,relative_humidity_2m,wind_speed_10m,` +
          `wind_direction_10m,wind_gusts_10m&wind_speed_unit=kmh&timezone=UTC`;

        const r = await fetchRetry(
          url,
          {
            headers: { "User-Agent": "alerte-incendie/1.0 (surveillance communale)" },
          },
          3,
          15_000,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);

        const j = await r.json();
        const c = j?.current;
        if (!c) throw new Error("réponse sans bloc current");

        const { data: risque, error: em } = await sb.rpc("maj_meteo", {
          p_zone: z.zone_id,
          p_mesure_at: c.time ? `${c.time}Z`.replace(/Z+$/, "Z") : new Date().toISOString(),
          p_temp: num(c.temperature_2m),
          p_humidite: num(c.relative_humidity_2m),
          p_vent: num(c.wind_speed_10m),
          p_rafales: num(c.wind_gusts_10m),
          p_deg: num(c.wind_direction_10m),
        });
        if (em) throw new Error(em.message);

        stats.zones[z.zone_id] = {
          risque,
          vent: c.wind_speed_10m,
          rafales: c.wind_gusts_10m,
          humidite: c.relative_humidity_2m,
        };
        ok++;
      } catch (e) {
        stats.zones[z.zone_id] = { erreur: String(e).slice(0, 200) };
      }
    }

    stats.zones_ok = ok;
    // La meteo est un confort : son indisponibilite ne doit jamais faire
    // passer le systeme pour muet. On n'echoue que si TOUTES les zones
    // echouent, ce qui signale une panne reelle de la source.
    if (ok === 0) throw new Error("aucune zone météo renseignée");

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
