// =====================================================================
//  Utilitaires purs : reseau et mise en forme.
// ---------------------------------------------------------------------
//  Volontairement separes de mod.ts, qui instancie un client Supabase
//  des l'import et exige donc SUPABASE_URL. Ces fonctions-la n'ont
//  besoin de rien : elles restent testables hors de tout environnement.
// =====================================================================

/** Compare deux secrets sans arrêt anticipé sur le premier caractère différent. */
export function comparerSecret(fourni: string, attendu: string): boolean {
  if (!attendu || fourni.length !== attendu.length) return false;
  let difference = 0;
  for (let i = 0; i < attendu.length; i++) {
    difference |= fourni.charCodeAt(i) ^ attendu.charCodeAt(i);
  }
  return difference === 0;
}

/** fetch avec réessais espacés. Les serveurs amont (NASA, IPMA, Open-Meteo)
 *  rendent régulièrement des 5xx passagers ; un seul essai transforme un
 *  hoquet de trois secondes en créneau de collecte perdu. */
export async function fetchRetry(
  url: string,
  init: RequestInit = {},
  essais = 3,
  timeoutMs = 30_000,
): Promise<Response> {
  let derniere: unknown;
  for (let i = 0; i < essais; i++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // 4xx : inutile d'insister, la requête elle-même est en cause.
      if (r.ok || (r.status >= 300 && r.status < 500)) return r;
      derniere = new Error(`HTTP ${r.status}`);
    } catch (e) {
      derniere = e;
    }
    if (i < essais - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
  }
  throw derniere instanceof Error ? derniere : new Error(String(derniere));
}

/** Rose des vents à 8 secteurs, en français, depuis un cap en degrés. */
export function secteurVent(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg)) return null;
  const s = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  return s[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** Appartenance à une emprise française.
 *
 * Les territoires ultramarins sont volontairement décrits par boîtes
 * séparées. Une seule boîte allant de la Guyane à La Réunion accepterait
 * aussi une grande partie de l'Afrique et de l'Amérique du Sud. */
export function positionEnFrance(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const emprises = [
    [41, 51.5, -5.5, 10], // métropole et Corse
    [15.7, 16.6, -61.9, -60.9], // Guadeloupe
    [14.3, 15, -61.3, -60.7], // Martinique
    [2, 6, -54.7, -51.4], // Guyane
    [-21.5, -20.8, 55.1, 55.9], // La Réunion
    [-13.1, -12.5, 44.9, 45.4], // Mayotte
    [46.7, 47.2, -56.6, -56], // Saint-Pierre-et-Miquelon
    [17.8, 18.2, -63.2, -62.7], // Saint-Martin et Saint-Barthélemy
    [-14.5, -13, -178.3, -175.8], // Wallis-et-Futuna
    [-28, -7, -155, -134], // Polynésie française
    [-23.2, -19.4, 163.5, 168.2], // Nouvelle-Calédonie
    [10.1, 10.4, -109.4, -109.1], // Clipperton
  ] as const;
  return emprises.some(([sud, nord, ouest, est]) =>
    lat >= sud && lat <= nord && lon >= ouest && lon <= est
  );
}

/** Adresse réseau impropre à une requête sortante vers une source publique. */
export function adresseReseauInterdite(adresse: string): boolean {
  const ip = adresse.toLowerCase();
  if (
    ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") ||
    ip.startsWith("fe8") || ip.startsWith("fe9") || ip.startsWith("fea") ||
    ip.startsWith("feb")
  ) {
    return true;
  }
  const ipv4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip;
  return ipv4.startsWith("127.") || ipv4.startsWith("10.") ||
    ipv4.startsWith("192.168.") || ipv4.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4) || ipv4 === "0.0.0.0" ||
    /^22[4-9]\.|^23\d\./.test(ipv4);
}

/** Valide et réduit un PushSubscription fourni par le navigateur.
 *  L'endpoint est utilisé plus tard par la fonction d'envoi : refuser les
 *  hôtes locaux, les IP littérales et les URL avec identifiants évite d'en
 *  faire un vecteur évident de requêtes internes. */
export function normaliserAbonnementPush(v: any): Record<string, unknown> | null {
  const endpoint = String(v?.endpoint ?? "");
  const p256dh = String(v?.keys?.p256dh ?? "");
  const auth = String(v?.keys?.auth ?? "");
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return null;
  }
  const hote = u.hostname.toLowerCase();
  const hoteInterdit = hote === "localhost" || hote.endsWith(".local") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hote) || hote.includes(":");
  if (
    u.protocol !== "https:" || endpoint.length > 2048 ||
    u.username || u.password || hoteInterdit ||
    p256dh.length < 16 || p256dh.length > 512 ||
    auth.length < 8 || auth.length > 256
  ) return null;

  return {
    endpoint: u.toString(),
    expirationTime: v?.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

/** Un compte peut contribuer aux signalements seulement après activation
 *  d'une notification Web Push sur l'un de ses appareils. Le jeton seul
 *  prouve la possession du navigateur, pas l'existence d'un appareil joignable. */
export function aUnCanalVerifie(canaux: unknown): boolean {
  if (!Array.isArray(canaux)) return false;
  return canaux.some((canal) =>
    canal !== null &&
    typeof canal === "object" &&
    (canal as { type?: unknown }).type === "webpush" &&
    (canal as { actif?: unknown }).actif === true &&
    (canal as { verifie?: unknown }).verifie === true
  );
}

export type Emprise = {
  sud: number;
  nord: number;
  ouest: number;
  est: number;
};

/** Emprise minimale de collecte pour la France métropolitaine et la Corse.
 *
 * Les événements et notifications restent limités aux zones des abonnés,
 * mais la collecte nationale alimente la carte publique. Une zone située
 * hors de cette emprise étend le rectangle afin de préserver le comportement
 * historique pour les abonnés ultramarins.
 */
export function empriseFranceEtZones(bbox: Partial<Emprise> | null | undefined): Emprise {
  const france: Emprise = { sud: 41, nord: 51.5, ouest: -5.5, est: 10 };
  if (
    !bbox ||
    !Number.isFinite(bbox.sud) ||
    !Number.isFinite(bbox.nord) ||
    !Number.isFinite(bbox.ouest) ||
    !Number.isFinite(bbox.est)
  ) return france;
  return {
    sud: Math.min(france.sud, Number(bbox.sud)),
    nord: Math.max(france.nord, Number(bbox.nord)),
    ouest: Math.min(france.ouest, Number(bbox.ouest)),
    est: Math.max(france.est, Number(bbox.est)),
  };
}
