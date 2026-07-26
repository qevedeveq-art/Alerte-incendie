// =====================================================================
//  Analyse des flux CSV NASA FIRMS.
// ---------------------------------------------------------------------
//  Isole du point d'entree pour etre testable : importer index.ts
//  declencherait Deno.serve et lancerait un serveur pendant les tests.
// =====================================================================

/** VIIRS renvoie low/nominal/high, MODIS un pourcentage : on normalise sur 0-100. */
export function normaliserConfiance(v: string): number | null {
  const t = (v ?? "").trim().toLowerCase();
  if (t === "l" || t === "low") return 20;
  if (t === "n" || t === "nominal") return 60;
  if (t === "h" || t === "high") return 90;
  const n = Number(t);
  return Number.isFinite(n) && t !== "" ? n : null;
}

/** acq_date=2026-07-24 + acq_time=0030 (UTC) -> 2026-07-24T00:30:00Z */
export function horodatage(date: string, time: string): string {
  const t = String(time ?? "0").trim().padStart(4, "0");
  return `${date}T${t.slice(0, 2)}:${t.slice(2, 4)}:00Z`;
}

/** Valeur numérique, en distinguant « zéro » de « absent ».
 *  `Number(x) || null` transformait une FRP de 0 en null : rare, mais
 *  0 MW est une mesure, pas une absence de mesure. */
export function nombreOuNull(v: unknown): number | null {
  const t = String(v ?? "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** CSV FIRMS : pas de champ cité, mais des fins de ligne CRLF possibles. */
export function parserCsv(txt: string): Record<string, string>[] {
  const lignes = txt.trim().split(/\r?\n/);
  if (lignes.length < 2) return [];
  const entetes = lignes[0].split(",").map((h) => h.trim());
  const out: Record<string, string>[] = [];
  for (let i = 1; i < lignes.length; i++) {
    const cols = lignes[i].split(",");
    if (cols.length < entetes.length) continue;
    const o: Record<string, string> = {};
    entetes.forEach((h, j) => (o[h] = (cols[j] ?? "").trim()));
    out.push(o);
  }
  return out;
}
