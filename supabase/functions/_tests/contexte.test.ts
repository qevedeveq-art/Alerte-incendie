import { assert, assertEquals } from "./assert.ts";
import {
  contientVocabulaireFeu,
  decoderEntites,
  empreinteMention,
  extraireArticles,
  nettoyerHtml,
  urlCanonique,
} from "../poll-contexte/flux.ts";

const pwa = await Deno.readTextFile("../../web/index.html");
const api = await Deno.readTextFile("api/index.ts");
const collecteur = await Deno.readTextFile("poll-contexte/index.ts");
const migration = await Deno.readTextFile(
  "../migrations/20260727000000_39_contexte_exploitable_et_azimut.sql",
);

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Flux de test</title>
  <item>
    <title><![CDATA[Incendie ma&#238;tris&eacute; &agrave; Cornebarrieu]]></title>
    <link>https://exemple.fr/article-1?utm_source=rss&amp;utm_medium=flux</link>
    <description>&lt;p&gt;Les pompiers du SDIS 31 sont intervenus sur 3 hectares.&lt;/p&gt;</description>
    <pubDate>Sat, 25 Jul 2026 18:30:00 +0200</pubDate>
  </item>
  <item>
    <title>Conseil municipal : le budget voirie adopté</title>
    <link>https://exemple.fr/article-2</link>
    <description>Séance ordinaire du conseil.</description>
    <pubDate>Sat, 25 Jul 2026 09:00:00 +0200</pubDate>
  </item>
  <item>
    <title>Feu de broussailles sans lien mais en http</title>
    <link>http://exemple.fr/article-3</link>
  </item>
</channel></rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Feu de forêt en cours dans le Var</title>
    <link rel="alternate" href="https://exemple.fr/atom-1#partage"/>
    <summary type="html">&lt;b&gt;120 hectares&lt;/b&gt; parcourus, canadairs engagés.</summary>
    <published>2026-07-25T16:00:00Z</published>
  </entry>
</feed>`;

Deno.test("les entités et le HTML des flux sont décodés puis mis à plat", () => {
  assertEquals(decoderEntites("ma&#238;tris&eacute;"), "maîtrisé");
  assertEquals(decoderEntites("Var &amp; Corse"), "Var & Corse");
  assertEquals(nettoyerHtml("<p>Trois   <b>hectares</b></p>"), "Trois hectares");
  assertEquals(nettoyerHtml("<![CDATA[Texte brut]]>"), "Texte brut");
  // Un script dans un résumé de flux ne doit pas survivre à l'extraction.
  assertEquals(nettoyerHtml("<script>alert(1)</script>Suite"), "Suite");
});

Deno.test("une URL d'article est canonisée, et seul https public est accepté", () => {
  assertEquals(
    urlCanonique("https://exemple.fr/a?utm_source=rss&id=7#bas"),
    "https://exemple.fr/a?id=7",
  );
  assertEquals(urlCanonique("http://exemple.fr/a"), null);
  assertEquals(urlCanonique("https://127.0.0.1/interne"), null);
  assertEquals(urlCanonique("https://192.168.1.10/interne"), null);
  assertEquals(urlCanonique("https://172.20.0.5/interne"), null);
  assertEquals(urlCanonique("javascript:alert(1)"), null);
  assertEquals(urlCanonique(null), null);
});

Deno.test("le lecteur extrait les articles RSS 2.0 et écarte le non-https", () => {
  const articles = extraireArticles(RSS);
  assertEquals(articles.length, 2);
  assertEquals(articles[0].titre, "Incendie maîtrisé à Cornebarrieu");
  assertEquals(articles[0].url, "https://exemple.fr/article-1");
  assert(articles[0].resume?.includes("SDIS 31"));
  assertEquals(articles[0].publie?.toISOString(), "2026-07-25T16:30:00.000Z");
  // Le troisième élément est en http : il ne doit pas ressortir.
  assertEquals(articles.some((a) => a.url.includes("article-3")), false);
});

Deno.test("le lecteur comprend aussi Atom, dont le lien en attribut", () => {
  const articles = extraireArticles(ATOM);
  assertEquals(articles.length, 1);
  assertEquals(articles[0].url, "https://exemple.fr/atom-1");
  assert(articles[0].resume?.includes("120 hectares"));
});

Deno.test("un flux vide, tronqué ou hostile rend zéro article sans lever", () => {
  assertEquals(extraireArticles("").length, 0);
  assertEquals(extraireArticles("<rss><channel><item><title>court").length, 0);
  assertEquals(extraireArticles("pas du xml du tout").length, 0);
  assertEquals(extraireArticles(`<item><title>${"a".repeat(50_000)}</title></item>`).length, 0);
});

Deno.test("le filtre d'entrée retient le vocabulaire de feu, pas le reste", () => {
  assert(contientVocabulaireFeu("Incendie en cours"));
  assert(contientVocabulaireFeu("Les pompiers sur place"));
  assert(contientVocabulaireFeu("Feux de broussailles"));
  assertEquals(contientVocabulaireFeu("Le budget voirie adopté"), false);
  assertEquals(contientVocabulaireFeu(""), false);
});

Deno.test("l'empreinte de dédoublonnage est stable et distingue les sources", async () => {
  const a = await empreinteMention("FR_TEST", "https://x.fr/1", "Incendie à Rieumes");
  const b = await empreinteMention("FR_TEST", "https://x.fr/1", "incendie   à rieumes");
  const c = await empreinteMention("FR_AUTRE", "https://x.fr/1", "Incendie à Rieumes");
  assertEquals(a, b, "titre normalisé : même empreinte");
  assert(a !== c, "deux sources distinctes ne partagent pas une empreinte");
  assertEquals(a.length, 64);
});

Deno.test("le collecteur délègue l'association à la base et n'écrit rien d'autre", () => {
  assert(collecteur.includes('sb.rpc("enregistrer_mention_contexte"'));
  assert(collecteur.includes('sb.rpc("purger_contexte_local")'));
  // Aucune écriture directe vers les tables de preuve ou d'alerte.
  for (const interdit of ['evenements").update', 'alertes").insert', 'detections").insert']) {
    assertEquals(collecteur.includes(interdit), false, `écriture interdite : ${interdit}`);
  }
  // Une source désactivée n'est jamais contactée.
  assert(collecteur.includes('.eq("actif", true)'));
  assert(collecteur.includes('.neq("mode", "desactive")'));
});

Deno.test("la route publique de contexte exige un identifiant d'évènement", () => {
  assert(api.includes("UUID.test(evenementId)"));
  assert(api.includes('.eq("decision", "associe")'));
  // La carte n'envoie plus son identifiant d'affichage.
  assertEquals(pwa.includes("contexte?groupe="), false);
  assert(pwa.includes("contexte?evenement="));
});

Deno.test("la PWA n'appelle que des constantes d'API réellement déclarées", () => {
  // `API_BASE` etait utilise dans deux fetch sans avoir jamais ete declare :
  // ReferenceError silencieuse, et rubrique de contexte jamais chargee.
  const declarees = new Set(
    [...pwa.matchAll(/^const (API[A-Z_]*) =/gm)].map((m) => m[1]),
  );
  assert(declarees.has("API"), "la constante API doit être déclarée");
  const utilisees = new Set(
    [...pwa.matchAll(/\$\{(API[A-Z_]*)\}/g)].map((m) => m[1]),
  );
  for (const nom of utilisees) {
    assert(declarees.has(nom), `constante d'API utilisée mais non déclarée : ${nom}`);
  }
});

Deno.test("la migration 39 respecte les invariants du contexte", () => {
  // Le contexte ne touche jamais aux preuves ni aux alertes.
  for (
    const interdit of [
      "update public.evenements",
      "insert into public.alertes",
      "update public.detections",
    ]
  ) {
    assertEquals(migration.includes(interdit), false, `interdit : ${interdit}`);
  }
  // Publication verrouillée : seul le mode actif peut publier automatiquement.
  assert(migration.includes("and v_src.mode = 'actif' then 'associe'"));
  assert(migration.includes("else 'a_valider'"));
  // Barème conforme au plan.
  assert(migration.includes("v_score + 45"));
  assert(migration.includes("v_score + 35"));
  assert(migration.includes("v_score + 15"));
  assert(migration.includes("v_score - 60"));
  // Presse régionale sans licence ouverte : désactivée.
  assert(migration.includes("where type = 'media'"));
  assert(migration.includes("mode = 'desactive'"));
  // Identifiant d'évènement restitué par la carte.
  assert(migration.includes("'evenement_id', evenement_id"));
  // Droits : rien pour public, anon, authenticated.
  assert(migration.includes("revoke all on function public.enregistrer_mention_contexte("));
  assert(
    migration.includes(
      "grant execute on function public.moderation_contexte(integer) to service_role",
    ),
  );
});

Deno.test("la PWA n'affiche ni vitesse de front, ni pente inventée", () => {
  // Le km/h déduit de la puissance thermique n'existe plus.
  assertEquals(pwa.includes("calculerVelociteFeu"), false);
  assertEquals(pwa.includes("vitesse avancée"), false);
  assertEquals(pwa.includes("triangulerVisees"), false);
  assert(pwa.includes("function persistanceFeu("));
  assert(pwa.includes("durée d’activité observée"));
  assert(pwa.includes("ni la vitesse, ni le sens de propagation"));
  // Pente : quatre orientations, et aucune valeur de repli inventée.
  assert(pwa.includes("nom: 'nord'"));
  assert(pwa.includes("nom: 'ouest'"));
  assertEquals(pwa.includes("'Pente modérée'"), false);
  assert(pwa.includes("'non disponible'"));
});

Deno.test("la fiche incident ne replie ni le vent, ni le rappel des secours", () => {
  // Le <details> « Détails techniques » n'était pas fermé : tout ce qui
  // suivait — vent, contexte, boutons et rappel du 18/112 — se retrouvait
  // dans un volet replié.
  const ouverts = (pwa.match(/<details/g) || []).length;
  const fermes = (pwa.match(/<\/details>/g) || []).length;
  assertEquals(ouverts, fermes, "chaque <details> doit être fermé");

  const fiche = pwa.slice(pwa.indexOf("Détails techniques de l’indice"));
  const finDetails = fiche.indexOf("</details>");
  assert(finDetails > 0);
  const apres = fiche.slice(finDetails);
  for (const visible of ["Vent au point du feu", "Appelez le 18 ou le 112", "Partager"]) {
    assert(apres.includes(visible), `doit rester visible : ${visible}`);
  }
});

Deno.test("le vent décrit l’air sans prétendre mesurer la propagation du feu", () => {
  assert(pwa.includes("function secteurVent("));
  assert(pwa.includes("(deg + 180) % 360"));
  assert(pwa.includes("direction vers laquelle souffle le vent"));
  assertEquals(pwa.includes("<small>propagation probable</small>"), false);
  // Même rose des vents que le serveur, pour éviter deux récits différents.
  for (const secteur of ["nord-est", "sud-ouest", "nord-ouest"]) {
    assert(pwa.includes(`'${secteur}'`), `secteur absent : ${secteur}`);
  }
});

Deno.test("la rubrique de contexte reste masquée quand rien n'est publié", () => {
  assert(pwa.includes('<div id="blocContexteLocal" hidden></div>'));
  assert(pwa.includes("function chargerContexteLocal("));
  assert(pwa.includes("if (!mentions.length) return;"));
  // Seuls les liens https sont rendus.
  assert(pwa.includes("/^https:\\/\\//i.test(m.url"));
  assert(pwa.includes("Contexte, pas une preuve"));
});
