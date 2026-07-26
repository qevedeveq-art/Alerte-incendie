// =====================================================================
//  poll-lsasaf — surveillance géostationnaire (Meteosat / SEVIRI)
// ---------------------------------------------------------------------
//  Complément de poll-firms. Meteosat regarde l'Europe en permanence,
//  là où VIIRS et MODIS ne passent que 4 à 8 fois par jour :
//
//                  cadence      latence      résolution   seuil
//    FIRMS         4-8/jour     2-3 h        375 m        faible
//    LSA SAF MSG   15 min       ~25 min      3 km         ~20 MW
//
//  Produit : FRP-PIXEL List Product, HDF5, ~150 Ko par créneau, environ
//  2000 pixels de feu sur tout le disque MSG (Europe, Afrique, Amérique
//  du Sud) dont on ne garde que l'emprise surveillée.
//
//  Structure relevée sur fichier réel : datasets 1D parallèles à la
//  racine, un enregistrement par pixel de feu, entiers à diviser par
//  SCALING_FACTOR.
//
//    LATITUDE / LONGITUDE  int16, /100,  degrés, manquant = 19000
//    FRP                   int32, /10,   MW,     manquant = -999
//    FRP_UNCERTAINTY       int16, /100,  MW
//    FIRE_CONFIDENCE       int16, /100   -> la valeur brute est le %
//    PIXEL_SIZE            int16, /100,  km² (empreinte réelle au sol)
//    BT_MIR / BT_TIR       int16, /10,   K
//    ACQTIME               int16, HHMM UTC du balayage de la ligne
//
//  Licence des données : CC BY 4.0, EUMETSAT / LSA SAF.
// =====================================================================
import { sb, config, json, CORS, estInterne, verifierAdmin, ouvrirRun, fermerRun } from "../_shared/mod.ts";
import * as h5wasm from "npm:h5wasm@0.7.5";

const BASE = "https://datalsasaf.lsasvcs.ipma.pt/PRODUCTS/MSG/FRP-PIXEL/HDF5";
const SOURCE = "MSG_SEVIRI";

// Le produit est publié environ 17 à 25 min après le début du créneau.
const LATENCE_MIN = 20;
// Fenêtre de rattrapage : 4 créneaux = 1 h. Au-delà, un feu serait de toute
// façon déjà vu par le passage polaire suivant.
const NB_CRENEAUX = 4;
// Plafond de décodages par exécution, pour rester loin de la limite de temps.
const MAX_DECODAGES = 3;

// Filtre qualité propre au géostationnaire : à 3 km de résolution, une source
// industrielle faible produirait des alertes avant que l'apprentissage des
// sources permanentes n'ait eu le temps de la reconnaître.
const CONF_MIN = 40;   // %
const FRP_MIN = 15;    // MW

function creneaux(): { url: string; slot: string }[] {
  const t = new Date(Date.now() - LATENCE_MIN * 60_000);
  t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  return Array.from({ length: NB_CRENEAUX }, (_, i) => {
    const d = new Date(t.getTime() - i * 15 * 60_000);
    const AAAA = d.getUTCFullYear(), MM = p(d.getUTCMonth() + 1), JJ = p(d.getUTCDate());
    const slot = `${AAAA}${MM}${JJ}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
    return { slot, url: `${BASE}/${AAAA}/${MM}/${JJ}/HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_${slot}` };
  });
}

const nb = (x: unknown) => (typeof x === "bigint" ? Number(x) : Number(x));

/** Lit un dataset 1D et applique SCALING_FACTOR / OFFSET. */
function serie(f: any, nom: string): { v: number[]; manquant: number } {
  const d = f.get(nom);
  if (!d) throw new Error(`dataset ${nom} absent`);
  const attr = (n: string) => {
    const a = d.attrs?.[n]?.value;
    return nb(Array.isArray(a) ? a[0] : a);
  };
  const ech = attr("SCALING_FACTOR") || 1;
  const off = attr("OFFSET") || 0;
  const manquant = attr("MISSING_VALUE");
  return {
    v: Array.from(d.value as ArrayLike<unknown>).map((x) => (nb(x) - off) / ech),
    manquant: Number.isFinite(manquant) ? manquant / ech : NaN,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!estInterne(req) && !await verifierAdmin(req)) return json({ erreur: "non autorisé" }, 401);

  const runId = await ouvrirRun("poll-lsasaf");
  const stats: Record<string, any> = { creneaux: {} };

  try {
    const cfg = await config(true);
    const ident = cfg.lsasaf ?? {};
    if (!ident.actif || !ident.utilisateur || !ident.motdepasse) {
      await fermerRun(runId, true, { note: "source désactivée" });
      return json({ ok: true, note: "config.lsasaf inactif ou incomplet" });
    }

    const { data: bbox, error: eb } = await sb.rpc("bbox_surveillance", { p_marge_deg: 0.08 });
    if (eb) throw new Error(`bbox: ${eb.message}`);
    if (!bbox) {
      await fermerRun(runId, true, { note: "aucune zone active" });
      return json({ ok: true, note: "aucune zone active" });
    }

    // Journal des créneaux : un créneau sans feu dans l'emprise n'insère aucune
    // détection, il faut donc le tracer explicitement pour ne pas le refaire.
    const tous = creneaux();
    const { data: aFaire, error: ec } = await sb.rpc("creneaux_a_traiter", {
      p_source: SOURCE, p_slots: tous.map((c) => c.slot),
    });
    if (ec) throw new Error(`creneaux: ${ec.message}`);
    const restants = new Set(aFaire ?? []);
    stats.creneaux_deja_traites = tous.length - restants.size;

    const auth = "Basic " + btoa(`${ident.utilisateur}:${ident.motdepasse}`);
    const { FS } = await h5wasm.ready;
    const aInserer: Record<string, unknown>[] = [];
    let decodages = 0;

    for (const c of tous) {
      if (!restants.has(c.slot)) continue;
      if (decodages >= MAX_DECODAGES) { stats.creneaux[c.slot] = "reporté"; continue; }
      try {
        const r = await fetch(c.url, {
          headers: { Authorization: auth, "User-Agent": "alerte-incendie/1.0" },
          signal: AbortSignal.timeout(35_000),
        });
        if (r.status === 404) { stats.creneaux[c.slot] = "pas encore publié"; continue; }
        if (r.status === 401 || r.status === 403) throw new Error(`accès refusé (${r.status})`);
        if (!r.ok) { stats.creneaux[c.slot] = `HTTP ${r.status}`; continue; }

        const chemin = `s${c.slot}.h5`;
        FS.writeFile(chemin, new Uint8Array(await r.arrayBuffer()));
        const f = new h5wasm.File(chemin, "r");
        decodages++;

        try {
          const lat = serie(f, "LATITUDE"), lon = serie(f, "LONGITUDE");
          const frp = serie(f, "FRP"), conf = serie(f, "FIRE_CONFIDENCE");
          const taille = serie(f, "PIXEL_SIZE"), bt = serie(f, "BT_MIR");
          const acq = serie(f, "ACQTIME");

          let retenus = 0, dansEmprise = 0;
          for (let i = 0; i < lat.v.length; i++) {
            const la = lat.v[i], lo = lon.v[i];
            if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
            if (la === lat.manquant || lo === lon.manquant) continue;
            if (la < bbox.sud || la > bbox.nord || lo < bbox.ouest || lo > bbox.est) continue;
            dansEmprise++;

            const confPct = Math.round(conf.v[i] * 100);
            const puissance = frp.v[i];
            if (!Number.isFinite(puissance) || puissance === frp.manquant) continue;
            if (confPct < CONF_MIN || puissance < FRP_MIN) continue;

            // ACQTIME donne l'heure réelle de balayage de la ligne (HHMM UTC)
            const hhmm = String(Math.round(acq.v[i] * 100)).padStart(4, "0");
            const hh = hhmm.slice(0, 2), mi = hhmm.slice(2, 4);
            const j = `${c.slot.slice(0, 4)}-${c.slot.slice(4, 6)}-${c.slot.slice(6, 8)}`;
            const ts = /^([01]\d|2[0-3])$/.test(hh) && /^[0-5]\d$/.test(mi)
              ? `${j}T${hh}:${mi}:00Z`
              : `${j}T${c.slot.slice(8, 10)}:${c.slot.slice(10, 12)}:00Z`;

            // PIXEL_SIZE est une surface en km² : on en tire un côté équivalent
            const cote = Number.isFinite(taille.v[i]) && taille.v[i] > 0
              ? Math.round(Math.sqrt(taille.v[i]) * 1000)
              : 3000;

            aInserer.push({
              source: SOURCE,
              acq_ts: ts,
              lat: la, lon: lo,
              geom: `SRID=4326;POINT(${lo} ${la})`,
              confiance: confPct >= 70 ? "high" : confPct >= 50 ? "nominal" : "low",
              confiance_num: confPct,
              frp: Math.round(puissance * 10) / 10,
              brillance: Number.isFinite(bt.v[i]) && bt.v[i] !== bt.manquant
                ? Math.round(bt.v[i] * 10) / 10 : null,
              daynight: null,
              resolution_m: cote,
              fingerprint: `${SOURCE}|${la.toFixed(2)}|${lo.toFixed(2)}|${c.slot}`,
            });
            retenus++;
          }

          stats.creneaux[c.slot] = { pixels_disque: lat.v.length, dans_emprise: dansEmprise, retenus };
          await sb.rpc("marquer_creneau", {
            p_source: SOURCE, p_slot: c.slot, p_pixels: lat.v.length, p_retenus: retenus,
          });
        } finally {
          f.close();
          try { FS.unlink(chemin); } catch { /* sans conséquence */ }
        }
      } catch (e) {
        stats.creneaux[c.slot] = `erreur: ${String(e).slice(0, 150)}`;
      }
    }

    stats.decodages = decodages;
    stats.a_inserer = aInserer.length;

    // Un run sans aucun créneau exploitable et sans rien de déjà traité signale
    // une panne côté source : le contrôle de santé doit pouvoir le voir.
    if (decodages === 0 && stats.creneaux_deja_traites === 0) {
      throw new Error("aucun créneau LSA SAF exploitable");
    }

    let inserees = 0;
    for (let i = 0; i < aInserer.length; i += 200) {
      const { data, error } = await sb.from("detections")
        .upsert(aInserer.slice(i, i + 200), { onConflict: "fingerprint", ignoreDuplicates: true })
        .select("id");
      if (error) throw new Error(`insert: ${error.message}`);
      inserees += data?.length ?? 0;
    }
    stats.nouvelles_detections = inserees;

    if (inserees > 0) {
      const { data: nbPerm } = await sb.rpc("apprendre_sources_permanentes");
      stats.detections_ecartees_permanentes = nbPerm ?? 0;

      const { data: agg, error: ea } = await sb.rpc("traiter_detections");
      if (ea) throw new Error(`traiter: ${ea.message}`);
      stats.agregation = agg;

      const { count } = await sb.from("alertes")
        .select("id", { count: "exact", head: true }).eq("statut", "en_attente");
      if ((count ?? 0) > 0) {
        const d = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/dispatch`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
          },
          body: JSON.stringify({ interne: true }),
        });
        stats.dispatch = d.ok ? await d.json().catch(() => "ok") : `HTTP ${d.status}`;
      }
    }

    await fermerRun(runId, true, stats);
    return json({ ok: true, stats });
  } catch (e) {
    await fermerRun(runId, false, stats, String(e));
    return json({ ok: false, erreur: String(e), stats }, 500);
  }
});
