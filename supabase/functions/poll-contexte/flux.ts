// =====================================================================
//  Lecture des flux RSS 2.0 et Atom — fonctions pures et testables
// ---------------------------------------------------------------------
//  Volontairement sans dépendance : pas de parseur XML externe dans une
//  Edge Function qui lit des sources tierces. Un flux malformé ou
//  volontairement hostile doit produire zéro article, jamais une
//  exception non rattrapée ni une boucle qui ne rend pas la main.
//
//  Ces fonctions ne décident rien : elles extraient. Le rattachement à
//  un évènement et le barème vivent en base, dans
//  public.enregistrer_mention_contexte, seule couche qui connaisse les
//  contours communaux.
// =====================================================================

/** Un élément de flux, normalisé. */
export interface ArticleFlux {
  titre: string;
  resume: string | null;
  url: string;
  publie: Date | null;
}

/** Taille maximale lue d'un flux. Au-delà, la source est tronquée : un
 *  flux de plusieurs mégaoctets est soit une erreur, soit une tentative
 *  d'épuisement mémoire. */
export const TAILLE_MAX_FLUX = 400_000;

/** Nombre maximal d'articles retenus par flux et par passage. */
export const ARTICLES_MAX = 40;

const ENTITES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  laquo: "«",
  raquo: "»",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  agrave: "à",
  ccedil: "ç",
  ugrave: "ù",
  ocirc: "ô",
  icirc: "î",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  mdash: "—",
  ndash: "–",
  deg: "°",
};

/** Décode les entités XML/HTML usuelles et les références numériques. */
export function decoderEntites(texte: string): string {
  return texte
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d) => codePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, nom) => ENTITES[String(nom).toLowerCase()] ?? m);
}

function codePoint(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 0x10ffff) return "";
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/** Retire CDATA, balises et espaces superflus. Le résultat est du texte
 *  brut : la PWA l'échappe de nouveau avant insertion dans le DOM. */
export function nettoyerHtml(brut: string): string {
  return decoderEntites(
    brut
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]{0,2000}>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function premierGroupe(bloc: string, motifs: RegExp[]): string | null {
  for (const motif of motifs) {
    const m = motif.exec(bloc);
    if (m && m[1] !== undefined) {
      const valeur = nettoyerHtml(m[1]);
      if (valeur) return valeur;
    }
  }
  return null;
}

/** Normalise une URL d'article : https obligatoire, fragment et
 *  paramètres de campagne retirés pour que la même dépêche reprise deux
 *  fois ne compte pas deux fois. */
export function urlCanonique(brut: string | null): string | null {
  if (!brut) return null;
  let u: URL;
  try {
    u = new URL(brut.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const h = u.hostname.toLowerCase();
  if (
    h === "localhost" || h.endsWith(".local") || h.startsWith("127.") ||
    h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")
  ) {
    return null;
  }
  u.hash = "";
  for (const cle of [...u.searchParams.keys()]) {
    if (/^(utm_|xtor|fbclid|gclid|mtm_|pk_)/i.test(cle)) u.searchParams.delete(cle);
  }
  return u.toString();
}

/** Extrait les articles d'un flux RSS 2.0 ou Atom. */
export function extraireArticles(xml: string, max = ARTICLES_MAX): ArticleFlux[] {
  const texte = String(xml ?? "").slice(0, TAILLE_MAX_FLUX);
  const blocs = texte.match(/<(?:item|entry)\b[\s\S]{0,20000}?<\/(?:item|entry)>/gi) ?? [];
  const articles: ArticleFlux[] = [];

  for (const bloc of blocs) {
    if (articles.length >= max) break;

    const titre = premierGroupe(bloc, [/<title[^>]{0,200}>([\s\S]{0,1000}?)<\/title>/i]);
    if (!titre || titre.length < 8) continue;

    // Atom expose l'URL en attribut, RSS dans le contenu de la balise.
    const lienAtom = /<link\b[^>]{0,400}?href=["']([^"']{1,2000})["']/i.exec(bloc);
    const lienRss = /<link[^>]{0,200}>([\s\S]{0,2000}?)<\/link>/i.exec(bloc);
    const guid = /<guid[^>]{0,200}>([\s\S]{0,2000}?)<\/guid>/i.exec(bloc);
    const url = urlCanonique(
      lienAtom?.[1] ?? (lienRss?.[1] ? nettoyerHtml(lienRss[1]) : null) ??
        (guid?.[1] ? nettoyerHtml(guid[1]) : null),
    );
    if (!url) continue;

    const resume = premierGroupe(bloc, [
      /<description[^>]{0,200}>([\s\S]{0,4000}?)<\/description>/i,
      /<summary[^>]{0,200}>([\s\S]{0,4000}?)<\/summary>/i,
      /<content[^>]{0,200}>([\s\S]{0,4000}?)<\/content>/i,
    ]);

    const dateBrute = premierGroupe(bloc, [
      /<pubDate[^>]{0,200}>([\s\S]{0,200}?)<\/pubDate>/i,
      /<published[^>]{0,200}>([\s\S]{0,200}?)<\/published>/i,
      /<updated[^>]{0,200}>([\s\S]{0,200}?)<\/updated>/i,
      /<dc:date[^>]{0,200}>([\s\S]{0,200}?)<\/dc:date>/i,
    ]);
    const publie = dateBrute ? new Date(dateBrute) : null;

    articles.push({
      titre: titre.slice(0, 300),
      resume: resume ? resume.slice(0, 600) : null,
      url,
      publie: publie && Number.isFinite(publie.getTime()) ? publie : null,
    });
  }

  return articles;
}

/** Vocabulaire de feu actif. Sert de filtre d'entrée peu coûteux : un
 *  article qui n'en contient aucun ne peut pas atteindre le seuil
 *  d'association, autant ne pas interroger la base. Le barème complet,
 *  lui, vit dans public.score_association_contexte. */
const MOTS_FEU = [
  "incendie",
  "feu",
  "feux",
  "flamme",
  "fumee",
  "fumée",
  "brasier",
  "sdis",
  "pompier",
  "canadair",
  "sinistre",
  "hectare",
];

export function contientVocabulaireFeu(texte: string): boolean {
  const t = String(texte ?? "").toLowerCase();
  return MOTS_FEU.some((m) => new RegExp(`(^|[^a-zà-ÿ])${m}`, "i").test(t));
}

/** Empreinte de dédoublonnage : source, URL canonique et titre normalisé.
 *  Une republication à l'identique ne crée donc pas une seconde mention. */
export async function empreinteMention(
  sourceCode: string,
  url: string,
  titre: string,
): Promise<string> {
  const base = `${sourceCode}|${url}|${titre.toLowerCase().replace(/\s+/g, " ").trim()}`;
  const octets = new TextEncoder().encode(base);
  const empreinte = await crypto.subtle.digest("SHA-256", octets);
  return [...new Uint8Array(empreinte)].map((o) => o.toString(16).padStart(2, "0")).join("");
}
