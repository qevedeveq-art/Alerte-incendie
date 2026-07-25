// =====================================================================
//  load-communes — alimentation du cache des contours communaux
// ---------------------------------------------------------------------
//  Source : geo.api.gouv.fr, qui expose le découpage IGN Admin Express.
//  Les contours sont simplifiés à ~56 m côté Postgres : largement
//  suffisant face à des pixels satellite de 375 m, et 7× plus compact
//  (l'Occitanie passe de 41 Mo à 6 Mo).
//
//    POST /load-communes  { "departements": ["31","32"] }
//    POST /load-communes  { "france": true }     // les 101 départements
//
//  En-tête requis : x-admin-key
// =====================================================================
import { sb, verifierAdmin, json, CORS, ouvrirRun, fermerRun } from "../_shared/mod.ts";

const DEPARTEMENTS_FRANCE = [
  ...Array.from({ length: 19 }, (_, i) => String(i + 1).padStart(2, "0")),   // 01..19
  "2A", "2B",
  ...Array.from({ length: 76 }, (_, i) => String(i + 21).padStart(2, "0")),  // 21..96
  "971", "972", "973", "974", "976",
];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const body = await req.json().catch(() => ({}));
  const deps: string[] = body.france
    ? DEPARTEMENTS_FRANCE
    : (Array.isArray(body.departements) ? body.departements : []);
  if (deps.length === 0) return json({ erreur: "departements[] ou france:true requis" }, 400);

  const runId = await ouvrirRun("load-communes");
  const resultat: Record<string, unknown> = {};
  let total = 0;

  for (const dep of deps) {
    try {
      const url = `https://geo.api.gouv.fr/departements/${dep}/communes` +
        `?fields=nom,code,contour,centre,population,surface&format=json`;

      let communes: any[] | null = null;
      for (let essai = 0; essai < 3 && !communes; essai++) {
        try {
          const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          communes = await r.json();
        } catch (e) {
          if (essai === 2) throw e;
          await new Promise((res) => setTimeout(res, 1500 * (essai + 1)));
        }
      }

      let inseres = 0;
      for (let i = 0; i < communes!.length; i += 100) {
        const payload = communes!.slice(i, i + 100)
          .filter((c) => c.contour)
          .map((c) => ({
            code: c.code, nom: c.nom, departement: dep,
            population: c.population ?? null, surface_ha: c.surface ?? null,
            centre: c.centre ?? null, contour: c.contour,
          }));
        if (payload.length === 0) continue;
        const { error } = await sb.rpc("upsert_communes", { p_data: payload });
        if (error) throw new Error(error.message);
        inseres += payload.length;
      }
      resultat[dep] = inseres;
      total += inseres;
    } catch (e) {
      resultat[dep] = `erreur: ${e}`;
    }
  }

  // Les géométries de surveillance dépendent du cache communal.
  const { data: zones } = await sb.from("zones").select("id");
  for (const z of zones ?? []) await sb.rpc("refresh_zone_geom", { p_zone_id: z.id });

  await fermerRun(runId, true, { departements: deps.length, communes: total });
  return json({ ok: true, total, resultat });
});
