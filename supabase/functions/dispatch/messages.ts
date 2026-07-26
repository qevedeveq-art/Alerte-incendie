// =====================================================================
//  Mise en forme des messages d'alerte, par canal.
// ---------------------------------------------------------------------
//  Le texte se DEDUIT des sources de l'evenement. La version precedente
//  ecrivait en dur « NASA FIRMS (VIIRS/MODIS), latence 2 a 3 h,
//  resolution 375 m » sur toutes les alertes — y compris celles issues
//  du geostationnaire (25 min, 3 km) et des signalements citoyens
//  (instantanes, non verifies). Le message decrivait donc une source
//  que l'alerte n'avait pas utilisee.
// =====================================================================
import { echapperHtml, echapperMdV2, secteurVent } from "../_shared/format.ts";

export type Meteo = {
  vent_kmh: number | null; rafales_kmh: number | null; vent_deg: number | null;
  temp_c: number | null; humidite_pct: number | null; risque: string | null;
};

export type Payload = {
  zone: string; commune: string; dans_commune: boolean; distance_m: number;
  distance_perso_m?: number | null; ref_libelle?: string | null;
  severite: "info" | "alerte" | "critique"; nb_detections: number;
  nb_signalements?: number; frp_max: number | null; sources: string[];
  origine?: "satellite" | "citoyen" | "mixte";
  resolution_m?: number | null; lat: number; lon: number;
  debut_ts: string; derniere_maj?: string; evenement_id: string;
  meteo?: Meteo | null; message?: string;
};

const PICTO = { info: "i", alerte: "!", critique: "!!!" } as const;
const TITRE = {
  info: "Point chaud détecté",
  alerte: "ALERTE INCENDIE",
  critique: "ALERTE INCENDIE CRITIQUE",
} as const;

const GEO = ["MSG_SEVIRI", "MTG_FCI"];

export function heureFr(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

/** Nom lisible des capteurs, sans jargon de fichier. */
export function capteursLisibles(sources: string[]): string {
  const noms = (sources ?? []).map((s) => {
    if (s === "CITOYEN") return "témoins";
    if (s === "MSG_SEVIRI") return "Meteosat";
    if (s === "MTG_FCI") return "Meteosat 3e génération";
    if (s === "ADSB") return "aéronefs de lutte";
    if (s.startsWith("VIIRS")) return "VIIRS";
    if (s === "MODIS") return "MODIS";
    return s;
  });
  return [...new Set(noms)].join(", ") || "n/d";
}

/**
 * Avertissement conforme aux sources REELLEMENT utilisees par cet
 * evenement. C'est le coeur de la correction : chaque source a sa
 * latence et sa resolution propres, et les melanger induit en erreur.
 */
export function avertissement(p: Payload): string {
  const s = p.sources ?? [];
  const citoyen = s.includes("CITOYEN");
  const geo = s.some((x) => GEO.includes(x));
  const polaire = s.some((x) => x.startsWith("VIIRS") || x === "MODIS");

  const morceaux: string[] = [];
  if (citoyen && (geo || polaire)) {
    morceaux.push(
      "Signalement de témoins confirmé par une détection satellite : " +
        "c'est le niveau de fiabilité le plus élevé de ce service.",
    );
  } else if (citoyen) {
    morceaux.push("Signalement de témoins, NON VÉRIFIÉ par satellite à cette heure.");
  }
  if (geo && !polaire) {
    morceaux.push(
      "Détection géostationnaire Meteosat : environ 25 minutes de latence, " +
        "résolution 3 km — la position est approximative.",
    );
  } else if (polaire && !geo) {
    morceaux.push(
      "Détection satellite polaire (NASA FIRMS) : 2 à 3 h de latence, résolution 375 m.",
    );
  } else if (geo && polaire) {
    morceaux.push(
      "Détections concordantes géostationnaire et polaire, deux systèmes indépendants.",
    );
  }
  morceaux.push("Ce service ne remplace ni FR-Alert ni le 18/112.");
  return morceaux.join(" ");
}

/** Phrase de localisation, personnalisée si l'abonné a un point de référence. */
function localisation(p: Payload): string {
  const km = (n: number) => (n / 1000).toFixed(1);
  if (p.distance_perso_m != null) {
    const ref = p.ref_libelle ? ` de ${p.ref_libelle}` : " de chez vous";
    return `À ${km(p.distance_perso_m)} km${ref}, sur ${p.commune}.`;
  }
  return p.dans_commune
    ? `Sur la commune de ${p.commune}.`
    : `À ${km(p.distance_m)} km du centre de ${p.zone}, sur ${p.commune}.`;
}

/** Le vent est la seule information qui rend l'alerte actionnable :
 *  sans lui, « feu à 4 km » ne dit pas s'il vient vers vous. */
export function phraseVent(m: Meteo | null | undefined): string | null {
  if (!m) return null;
  const v = m.rafales_kmh ?? m.vent_kmh;
  const secteur = secteurVent(m.vent_deg);
  if (v == null || secteur == null) return null;
  // Convention météo : la direction est celle d'où vient le vent.
  const vers = secteurVent(((m.vent_deg ?? 0) + 180) % 360);
  return `Vent de secteur ${secteur}, ${Math.round(v)} km/h — propagation probable vers le ${vers}.`;
}

export function titre(p: Payload) {
  return `${TITRE[p.severite]} — ${p.commune}`;
}

export function titreFin(p: Payload) {
  return `Fin d'alerte — ${p.commune}`;
}

function carteUrl(p: Payload) {
  return `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=14/${p.lat}/${p.lon}`;
}

// ---------------------------------------------------------------------
//  Texte brut (e-mail, notification push)
// ---------------------------------------------------------------------
export function corpsTexte(p: Payload) {
  const preuve = p.origine === "citoyen"
    ? `Signalements : ${p.nb_signalements ?? 0} témoin(s).`
    : `Détection : ${p.nb_detections} point(s) chaud(s) satellite` +
      (p.nb_signalements ? ` et ${p.nb_signalements} témoin(s)` : "") +
      (p.frp_max ? `, puissance max ${Number(p.frp_max).toFixed(1)} MW.` : ".");

  return [
    localisation(p),
    preuve,
    `Capteurs : ${capteursLisibles(p.sources)}.`,
    `Première observation : ${heureFr(p.debut_ts)} (heure de Paris).`,
    phraseVent(p.meteo),
    ``,
    `Position : ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
    `Carte : ${carteUrl(p)}`,
    ``,
    avertissement(p),
    `En cas de danger immédiat, appelez le 18 ou le 112.`,
  ].filter((l) => l !== null).join("\n");
}

/** Message de fin d'alerte : sans lui, la dernière information reçue
 *  par l'abonné reste une alerte incendie, indéfiniment. */
export function corpsFinTexte(p: Payload) {
  return [
    `Plus aucune détection sur cet évènement depuis 3 heures.`,
    localisation(p),
    `Dernière observation : ${heureFr(p.derniere_maj ?? p.debut_ts)} (heure de Paris).`,
    ``,
    `Les capteurs ne voient plus de point chaud à cet endroit. Cela ne garantit pas ` +
    `que le feu soit éteint : un foyer résiduel, couvert par les arbres ou les nuages, ` +
    `reste invisible depuis l'espace.`,
    `En cas de doute ou de danger, appelez le 18 ou le 112.`,
  ].join("\n");
}

// ---------------------------------------------------------------------
//  HTML (e-mail)
// ---------------------------------------------------------------------
export function corpsHtml(p: Payload) {
  const couleur = p.severite === "critique"
    ? "#b3261e"
    : p.severite === "alerte"
    ? "#e06c00"
    : "#5c6970";
  const ligne = (l: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#666">${l}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`;
  const vent = phraseVent(p.meteo);

  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px">
<div style="background:${couleur};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
<div style="font-size:13px;letter-spacing:.08em;opacity:.85">${TITRE[p.severite]}</div>
<div style="font-size:22px;font-weight:700;margin-top:2px">${echapperHtml(p.commune)}</div></div>
<div style="border:1px solid #e3e3e3;border-top:0;padding:20px;border-radius:0 0 10px 10px">
<p style="margin:0 0 14px;font-size:16px">${echapperHtml(localisation(p))}</p>
${
    vent
      ? `<p style="margin:0 0 14px;font-size:15px;background:#fff5e6;padding:10px 12px;border-radius:8px">${
        echapperHtml(vent)
      }</p>`
      : ""
  }
<table style="font-size:14px;border-collapse:collapse;width:100%">
${p.origine === "citoyen" ? "" : ligne("Points chauds", String(p.nb_detections))}
${p.nb_signalements ? ligne("Témoins", String(p.nb_signalements)) : ""}
${ligne("Puissance max", p.frp_max ? Number(p.frp_max).toFixed(1) + " MW" : "n/d")}
${ligne("Capteurs", echapperHtml(capteursLisibles(p.sources)))}
${ligne("Observation", heureFr(p.debut_ts))}
${ligne("Position", `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`)}
</table>
<p style="margin:18px 0 0"><a href="${
    echapperHtml(carteUrl(p))
  }" style="background:#1a1a1a;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-size:14px">Voir sur la carte</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#777;line-height:1.5">
${echapperHtml(avertissement(p))} En cas de danger immédiat, appelez le 18 ou le 112.</p>
</div></div>`;
}

export function corpsFinHtml(p: Payload) {
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px">
<div style="background:#2e7d32;color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
<div style="font-size:13px;letter-spacing:.08em;opacity:.85">FIN D'ALERTE</div>
<div style="font-size:22px;font-weight:700;margin-top:2px">${echapperHtml(p.commune)}</div></div>
<div style="border:1px solid #e3e3e3;border-top:0;padding:20px;border-radius:0 0 10px 10px">
<p style="margin:0 0 14px;font-size:16px">Plus aucune détection depuis 3 heures.</p>
<p style="margin:0 0 14px;font-size:14px;color:#444">${echapperHtml(localisation(p))}<br>
Dernière observation : ${heureFr(p.derniere_maj ?? p.debut_ts)}</p>
<p style="margin:0;font-size:12px;color:#777;line-height:1.5">
Les capteurs ne voient plus de point chaud à cet endroit. Cela ne garantit pas que le feu
soit éteint : un foyer résiduel, couvert par les arbres ou les nuages, reste invisible
depuis l'espace. En cas de doute, appelez le 18 ou le 112.</p>
</div></div>`;
}

// ---------------------------------------------------------------------
//  Telegram (MarkdownV2, intégralement échappé)
// ---------------------------------------------------------------------
export function corpsTelegram(p: Payload) {
  const e = echapperMdV2;
  const vent = phraseVent(p.meteo);
  const preuve = p.origine === "citoyen"
    ? `Témoins : *${p.nb_signalements ?? 0}*`
    : `Points chauds : *${p.nb_detections}*` +
      (p.frp_max ? ` — puissance *${e(Number(p.frp_max).toFixed(1))} MW*` : "");

  return [
    `${e(PICTO[p.severite])} *${e(TITRE[p.severite])}*`,
    ``,
    e(localisation(p)),
    vent ? `_${e(vent)}_` : null,
    preuve,
    `Capteurs : ${e(capteursLisibles(p.sources))}`,
    `Observation : ${e(heureFr(p.debut_ts))}`,
    ``,
    `[${e("Ouvrir la carte")}](https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon})`,
    ``,
    `_${e(avertissement(p))}_`,
  ].filter((l) => l !== null).join("\n");
}

export function corpsFinTelegram(p: Payload) {
  const e = echapperMdV2;
  return [
    `*${e("Fin d'alerte")} — ${e(p.commune)}*`,
    ``,
    e("Plus aucune détection sur cet évènement depuis 3 heures."),
    e(`Dernière observation : ${heureFr(p.derniere_maj ?? p.debut_ts)}`),
    ``,
    `_${e("Un foyer résiduel reste invisible depuis l'espace. En cas de doute, appelez le 18.")}_`,
  ].join("\n");
}
