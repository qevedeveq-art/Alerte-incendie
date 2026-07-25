// Mise en forme des messages d'alerte, par canal.

export type Payload = {
  zone: string; commune: string; dans_commune: boolean; distance_m: number;
  severite: "info" | "alerte" | "critique"; nb_detections: number;
  frp_max: number | null; sources: string[]; lat: number; lon: number;
  debut_ts: string; evenement_id: string; message?: string;
};

const PICTO = { info: "i", alerte: "!", critique: "!!!" } as const;
const TITRE = {
  info: "Point chaud détecté",
  alerte: "ALERTE INCENDIE",
  critique: "ALERTE INCENDIE CRITIQUE",
} as const;

export function heureFr(iso: string) {
  return new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris", day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

export function titre(p: Payload) {
  return `${TITRE[p.severite]} — ${p.commune}`;
}

export function corpsTexte(p: Payload) {
  const km = (p.distance_m / 1000).toFixed(1);
  const ou = p.dans_commune
    ? `Sur la commune de ${p.commune}.`
    : `À ${km} km du centre de ${p.zone}, sur ${p.commune}.`;
  return [
    ou,
    `Détection : ${p.nb_detections} point(s) chaud(s) satellite` +
      (p.frp_max ? `, puissance max ${Number(p.frp_max).toFixed(1)} MW.` : "."),
    `Capteurs : ${p.sources.join(", ")}.`,
    `Première observation : ${heureFr(p.debut_ts)} (heure de Paris).`,
    ``,
    `Position : ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`,
    `Carte : https://www.google.com/maps?q=${p.lat},${p.lon}`,
    ``,
    `Rappel : détection satellite, latence de 2 à 3 h, résolution 375 m.`,
    `En cas de danger immédiat, appelez le 18 ou le 112.`,
  ].join("\n");
}

export function corpsHtml(p: Payload) {
  const couleur = p.severite === "critique" ? "#b3261e" : p.severite === "alerte" ? "#e06c00" : "#5c6970";
  const km = (p.distance_m / 1000).toFixed(1);
  const ou = p.dans_commune
    ? `Sur la commune de <b>${p.commune}</b>.`
    : `À <b>${km} km</b> du centre de ${p.zone}, sur <b>${p.commune}</b>.`;
  const ligne = (l: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#666">${l}</td><td style="padding:6px 0;font-weight:600">${v}</td></tr>`;
  return `<div style="font-family:system-ui,Segoe UI,Roboto,sans-serif;max-width:560px">
<div style="background:${couleur};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0">
<div style="font-size:13px;letter-spacing:.08em;opacity:.85">ALERTE INCENDIE</div>
<div style="font-size:22px;font-weight:700;margin-top:2px">${p.commune}</div></div>
<div style="border:1px solid #e3e3e3;border-top:0;padding:20px;border-radius:0 0 10px 10px">
<p style="margin:0 0 14px;font-size:16px">${ou}</p>
<table style="font-size:14px;border-collapse:collapse;width:100%">
${ligne("Points chauds", String(p.nb_detections))}
${ligne("Puissance max", p.frp_max ? Number(p.frp_max).toFixed(1) + " MW" : "n/d")}
${ligne("Capteurs", p.sources.join(", "))}
${ligne("Observation", heureFr(p.debut_ts))}
${ligne("Position", `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`)}
</table>
<p style="margin:18px 0 0"><a href="https://www.google.com/maps?q=${p.lat},${p.lon}"
 style="background:#1a1a1a;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-size:14px">Voir sur la carte</a></p>
<p style="margin:18px 0 0;font-size:12px;color:#777;line-height:1.5">
Détection satellite NASA FIRMS (VIIRS/MODIS) : latence de 2 à 3 h, résolution 375 m.
Ce service ne remplace ni FR-Alert ni le 18/112. En cas de danger immédiat, appelez le 18 ou le 112.</p>
</div></div>`;
}

export function corpsTelegram(p: Payload) {
  const km = (p.distance_m / 1000).toFixed(1);
  const ou = p.dans_commune ? `sur *${p.commune}*` : `à *${km} km*, sur *${p.commune}*`;
  return [
    `${PICTO[p.severite]} *${TITRE[p.severite]}*`,
    ``,
    `Feu détecté ${ou}.`,
    `Points chauds : *${p.nb_detections}*` + (p.frp_max ? ` — puissance *${Number(p.frp_max).toFixed(1)} MW*` : ""),
    `Capteurs : ${p.sources.join(", ")}`,
    `Observation : ${heureFr(p.debut_ts)}`,
    ``,
    `[Ouvrir la carte](https://www.google.com/maps?q=${p.lat},${p.lon})`,
    ``,
    `_Satellite, latence 2-3 h. Danger immédiat : 18 ou 112._`,
  ].join("\n");
}
