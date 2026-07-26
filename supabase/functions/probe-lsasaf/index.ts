// =====================================================================
//  probe-lsasaf — validation du décodage, usage diagnostique
// ---------------------------------------------------------------------
//  Applique exactement la même logique de décodage que poll-lsasaf mais
//  n'insère rien, et rend compte du résultat sur des emprises connues.
//  Sert à prouver que le parseur est juste : un décodage faux produirait
//  des coordonnées hors du disque MSG, des FRP absurdes ou une
//  répartition géographique impossible.
//
//  Les identifiants sont lus dans public.config et ne sortent jamais de
//  la fonction : la réponse ne contient que la structure du fichier.
// =====================================================================
import { autoriserOperation, config, CORS, json } from "../_shared/mod.ts";
import * as h5wasm from "npm:h5wasm@0.7.5";

const BASE = "https://datalsasaf.lsasvcs.ipma.pt/PRODUCTS/MSG/FRP-PIXEL/HDF5";

const EMPRISES: Record<string, [number, number, number, number]> = {
  // nom : [ouest, sud, est, nord]
  france_metro: [-5.2, 41.3, 9.6, 51.1],
  peninsule_iberique: [-9.6, 36.0, 3.4, 43.8],
  occitanie: [-0.4, 42.3, 4.9, 45.1],
  disque_msg: [-80, -80, 80, 80],
};

const nb = (x: unknown) => (typeof x === "bigint" ? Number(x) : Number(x));

function serie(f: any, nom: string) {
  const d = f.get(nom);
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
  if (!await autoriserOperation(req, "probe-lsasaf", false)) {
    return json({ erreur: "non autorisé" }, 401);
  }

  const cfg = await config(true);
  const ident = cfg.lsasaf ?? {};
  if (!ident.utilisateur) return json({ ok: false, message: "config.lsasaf incomplet" });

  const t = new Date(Date.now() - 25 * 60_000);
  t.setUTCMinutes(Math.floor(t.getUTCMinutes() / 15) * 15, 0, 0);
  const p = (n: number) => String(n).padStart(2, "0");
  const slot = `${t.getUTCFullYear()}${p(t.getUTCMonth() + 1)}${p(t.getUTCDate())}` +
    `${p(t.getUTCHours())}${p(t.getUTCMinutes())}`;
  const url = `${BASE}/${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())}/` +
    `HDF5_LSASAF_MSG_FRP-PIXEL-ListProduct_MSG-Disk_${slot}`;

  const r = await fetch(url, {
    headers: { Authorization: "Basic " + btoa(`${ident.utilisateur}:${ident.motdepasse}`) },
    signal: AbortSignal.timeout(40_000),
  });
  if (!r.ok) return json({ ok: false, slot, statut: r.status });

  const { FS } = await h5wasm.ready;
  FS.writeFile("v.h5", new Uint8Array(await r.arrayBuffer()));
  const f = new h5wasm.File("v.h5", "r");

  try {
    const lat = serie(f, "LATITUDE"), lon = serie(f, "LONGITUDE");
    const frp = serie(f, "FRP"), conf = serie(f, "FIRE_CONFIDENCE");
    const taille = serie(f, "PIXEL_SIZE"), bt = serie(f, "BT_MIR");

    const n = lat.v.length;
    let valides = 0, manquants = 0, aberrantes = 0;
    let frpMin = Infinity, frpMax = -Infinity, frpSomme = 0;
    const comptes: Record<string, number> = {};
    const exemples: unknown[] = [];
    for (const k of Object.keys(EMPRISES)) comptes[k] = 0;

    for (let i = 0; i < n; i++) {
      const la = lat.v[i], lo = lon.v[i];
      if (la === lat.manquant || lo === lon.manquant) {
        manquants++;
        continue;
      }
      if (!Number.isFinite(la) || !Number.isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) {
        aberrantes++;
        continue;
      }
      valides++;
      const puissance = frp.v[i];
      if (Number.isFinite(puissance) && puissance !== frp.manquant) {
        frpMin = Math.min(frpMin, puissance);
        frpMax = Math.max(frpMax, puissance);
        frpSomme += puissance;
      }
      for (const [k, [o, s, e, no]] of Object.entries(EMPRISES)) {
        if (lo >= o && lo <= e && la >= s && la <= no) comptes[k]++;
      }
      if (exemples.length < 6 && lo >= -9.6 && lo <= 9.6 && la >= 36 && la <= 51.1) {
        exemples.push({
          lat: Math.round(la * 100) / 100,
          lon: Math.round(lo * 100) / 100,
          frp_mw: Math.round(puissance * 10) / 10,
          confiance_pct: Math.round(conf.v[i] * 100),
          pixel_km2: Math.round(taille.v[i] * 10) / 10,
          bt_mir_k: Math.round(bt.v[i] * 10) / 10,
        });
      }
    }

    return json({
      ok: true,
      slot,
      latence_minutes: Math.round(
        (Date.now() - Date.parse(
          `${slot.slice(0, 4)}-${slot.slice(4, 6)}-${slot.slice(6, 8)}T${slot.slice(8, 10)}:${
            slot.slice(10, 12)
          }:00Z`,
        )) / 60000,
      ),
      enregistrements: n,
      coordonnees: { valides, manquants, aberrantes },
      frp_mw: {
        min: frpMin === Infinity ? null : Math.round(frpMin * 10) / 10,
        max: frpMax === -Infinity ? null : Math.round(frpMax * 10) / 10,
        moyenne: valides ? Math.round(frpSomme / valides * 10) / 10 : null,
      },
      pixels_par_emprise: comptes,
      exemples_europe_ouest: exemples,
    });
  } finally {
    f.close();
  }
});
