// =====================================================================
//  Utilitaires purs : reseau et mise en forme.
// ---------------------------------------------------------------------
//  Volontairement separes de mod.ts, qui instancie un client Supabase
//  des l'import et exige donc SUPABASE_URL. Ces fonctions-la n'ont
//  besoin de rien : elles restent testables hors de tout environnement.
// =====================================================================

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
      if (r.ok || (r.status >= 400 && r.status < 500)) return r;
      derniere = new Error(`HTTP ${r.status}`);
    } catch (e) {
      derniere = e;
    }
    if (i < essais - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** i));
  }
  throw derniere instanceof Error ? derniere : new Error(String(derniere));
}

/** Échappe le MarkdownV2 de Telegram.
 *  Le mode « Markdown » historique rejetait tout message contenant un
 *  caractère spécial non apparié : un nom de commune avec un tiret bas ou
 *  une parenthèse, ou un message d'erreur repris dans un heartbeat,
 *  faisaient échouer l'envoi — donc perdre l'alerte. */
export function echapperMdV2(s: string): string {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => `\\${c}`);
}

/** Échappe le HTML des corps d'e-mail. */
export function echapperHtml(s: string): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string),
  );
}

/** Rose des vents à 8 secteurs, en français, depuis un cap en degrés. */
export function secteurVent(deg: number | null | undefined): string | null {
  if (deg == null || !Number.isFinite(deg)) return null;
  const s = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest"];
  return s[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
