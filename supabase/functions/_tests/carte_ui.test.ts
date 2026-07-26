import { assert, assertEquals } from "./assert.ts";

const pwa = await Deno.readTextFile("../../web/index.html");
const moderation = await Deno.readTextFile("../../web/moderation.html");
const serviceWorker = await Deno.readTextFile("../../web/sw.js");
const api = await Deno.readTextFile("api/index.ts");
const dispatch = await Deno.readTextFile("dispatch/index.ts");
const signalement = await Deno.readTextFile("signalement/index.ts");
const migrationNotifications = await Deno.readTextFile(
  "../migrations/20260726213000_35_notifications_appareil_uniquement.sql",
);

Deno.test("la carte utilise la vue satellite IGN par défaut et sait basculer", () => {
  assert(pwa.includes("ORTHOIMAGERY.ORTHOPHOTOS"));
  // Satellite et noms de localités par défaut ; plan sombre seulement quand
  // le navigateur demande d'économiser les données.
  assert(pwa.includes("if (donneesReduites) {"));
  assert(pwa.includes("planSombre.addTo(carte);"));
  assert(pwa.includes("satellite.addTo(carte);"));
  assert(pwa.includes("nomsFrancaisIGN.addTo(carte);"));
  assert(pwa.includes("erreursSatellite >= 4"));
  assert(pwa.includes("'Vue satellite + Noms français (IGN)'"));
  assert(pwa.includes("'Plan sombre': planSombre"));
});

Deno.test("la légende française distingue les statuts de preuve", () => {
  for (
    const libelle of [
      "Feux corroborés (≥2 sources)",
      "Signal fort / répété",
      "Indice automatique isolé",
      "Témoins vérifiés par quorum",
      "Témoignage non vérifié",
    ]
  ) {
    assert(pwa.includes(libelle), `Libellé absent : ${libelle}`);
  }
  // Chaque ligne de légende filtre la carte et porte son décompte.
  for (const cle of ["corrobore", "probable", "indice", "citoyen", "signalement"]) {
    assert(
      pwa.includes(`data-filtre-legende="${cle}"`),
      `Filtre de légende absent : ${cle}`,
    );
  }
});

Deno.test("les feux fiables sont des flammes et seul le non vérifié reste gris", () => {
  assert(pwa.includes("function svgFlamme("));
  assert(pwa.includes("function creerMarqueurFeu("));
  assert(pwa.includes("familles >= 2 ? 'corrobore'"));
  assert(pwa.includes("score >= 60 || puissance >= 50 || observations >= 3"));
  // Le témoignage non vérifié garde la teinte grise de la charte.
  assert(pwa.includes("const c = COULEUR_NIVEAU.signalement;"));
  assert(pwa.includes("signalement: '#7c8a94'"));
  // Un signalement confirmé ne doit jamais emprunter la couleur d'un feu.
  assertEquals(pwa.includes("s.confirme ? '#e9873a'"), false);
});

Deno.test("une seule table de couleurs de sévérité, conforme à la charte", () => {
  // La légende et les marqueurs portaient des hex différents pour la même
  // information : deux vocabulaires visuels pour un seul sens.
  assert(pwa.includes("const COULEUR_NIVEAU = {"));
  for (
    const [niveau, hex] of [
      ["corrobore", "#ff3b30"],
      ["probable", "#ff9500"],
      ["indice", "#ffd60a"],
      ["citoyen", "#af52de"],
    ]
  ) {
    assert(pwa.includes(`${niveau}: '${hex}'`), `Couleur de charte absente : ${niveau} ${hex}`);
  }
  for (const orphelin of ["#ef3829", "#ff8c32", "#ffd43b", "#a78bfa", "#8a8a8a"]) {
    assertEquals(pwa.includes(orphelin), false, `Couleur hors charte : ${orphelin}`);
  }
  // Un seul jeu de variables, et aucune trace de l'ancienne palette chaude.
  assertEquals((pwa.match(/:root\{/g) || []).length, 1);
  for (const chaud of ["#2e2a27", "#252220", "rgba(18,16,14", "#4b4541", "rgba(240,68,56"]) {
    assertEquals(pwa.includes(chaud), false, `Reste de l'ancienne palette : ${chaud}`);
  }
});

Deno.test("la légende masque réellement le niveau qu'elle annonce", () => {
  // Cliquer « indices isolés » remettait le filtre à « tous » en annonçant
  // l'inverse : seuls corroboré et probable agissaient.
  assert(pwa.includes("const niveauxMasques = new Set()"));
  assert(pwa.includes("!masques.has(aspect.niveau)"));
  assert(pwa.includes("niveauxMasques.has('signalement')"));
  assert(pwa.includes("function majEtatLegende("));
  assertEquals(pwa.includes("Filtre réactif de légende activé"), false);
  // Le repli de la légende est effectif, et ouvert par défaut.
  assert(pwa.includes(".legende-carte.ouverte .contenu-legende{display:block"));
  assert(pwa.includes("'legende-carte ouverte'"));
});

Deno.test("la carte explique les preuves et sépare les sources contextuelles", () => {
  assert(pwa.includes("Preuves disponibles"));
  assert(pwa.includes("chronologie"));
  assert(pwa.includes("Contexte EFFIS"));
  assert(pwa.includes("Météo des forêts officielle"));
  assert(pwa.includes("Il ne décrit ni le périmètre, ni la direction du feu"));
});

Deno.test("le signalement utilise un formulaire structuré", () => {
  for (
    const identifiant of [
      "sigNature",
      "sigIntensite",
      "sigVegetation",
      "sigCertitude",
      "sigObserveAt",
      "sigHabitations",
    ]
  ) {
    assert(pwa.includes(`id="${identifiant}"`), `Champ absent : ${identifiant}`);
  }
  assertEquals(pwa.includes("const nature = prompt("), false);
});

Deno.test("l’interface est carte-first, responsive et navigable sur mobile", () => {
  assert(pwa.includes('id="sectionCarte"'));
  assert(pwa.includes('class="navigation-mobile"'));
  assert(pwa.includes(".anonyme #vueApp{order:1}"));
  assert(pwa.includes('id="btnVoirCarte"'));
  // La carte est l'élément principal : elle occupe la colonne large et une
  // hauteur généreuse, et reprend toute la largeur sous 900 px.
  assert(pwa.includes("grid-template-columns:minmax(0,2.3fr) minmax(320px,.6fr)"));
  assert(pwa.includes("#map{height:clamp(560px,72vh,760px)}"));
  assert(pwa.includes("@media(max-width:900px)"));
  assert(pwa.includes("#map{height:clamp(400px,56vh,560px)}"));
  // Cadre et fraîcheur sont lisibles au-dessus de la carte.
  assert(pwa.includes('class="bandeau-carte"'));
  assert(pwa.includes('id="fraicheurCarte"'));
  assert(pwa.includes("function majFraicheurCarte("));
});

Deno.test("la charte 1A est appliquée : typographies, fonds et formes", () => {
  assert(pwa.includes("family=Inter:wght@400;550;600;700&family=Outfit:wght@500;650;700;800"));
  assert(pwa.includes("--fond:#0b0d10"));
  assert(pwa.includes("--fond2:#141820"));
  assert(pwa.includes("--fond3:#1c2024"));
  assert(pwa.includes("--bord:#2d3339"));
  assert(pwa.includes("--ombre:0 18px 50px rgba(0,0,0,.35)"));
  // Marque : flamme deux tons de la charte.
  assert(pwa.includes('fill="#ff3b30"'));
  assert(pwa.includes('fill="#ff9500"'));
  // La couleur du thème suit le fond de page, plus l'ancien rouge brique.
  assert(pwa.includes('name="theme-color" content="#0b0d10"'));
  // Respect du réglage système sur les animations.
  assert(pwa.includes("@media(prefers-reduced-motion:reduce)"));
});

Deno.test("la carte regroupe, filtre et détaille les incidents", () => {
  assert(pwa.includes('class="cluster-bulle"'));
  assert(pwa.includes("function feuxFiltres()"));
  assert(pwa.includes("function ouvrirIncident("));
  assert(pwa.includes('id="dialogIncident"'));
  assert(pwa.includes('data-heures="1"'));
  assert(pwa.includes('data-confiance="corrobore"'));
  assert(pwa.includes('id="listeFeuxVisibles"'));
});

Deno.test("le consentement précède et verrouille la création du compte", () => {
  const consentement = pwa.indexOf('id="consentement"');
  const creation = pwa.indexOf('id="btnCommencer"');
  assert(consentement >= 0);
  assert(creation > consentement);
  assert(pwa.slice(creation, creation + 160).includes("disabled"));
});

Deno.test("le mode hors ligne et l’installation PWA sont explicites", () => {
  assert(pwa.includes('id="bandeauOffline"'));
  assert(pwa.includes("alerte-incendie:feux-cache"));
  assert(pwa.includes("beforeinstallprompt"));
  assert(pwa.includes('id="btnInstaller"'));
  assert(serviceWorker.includes("const DEPENDANCES"));
  assert(serviceWorker.includes("basemaps.cartocdn.com"));
  assert(serviceWorker.includes("Promise.allSettled"));
});

Deno.test("la recherche publique localise une commune sans créer de compte", () => {
  assert(pwa.includes('id="rechLieu"'));
  assert(pwa.includes("function afficherLieu("));
  assert(pwa.includes("function rendreResumeCarte()"));
  assert(api.includes("codePostal=${encodeURIComponent(q)}"));
  assert(api.includes("population,centre"));
  assert(api.includes("lat: c.centre?.coordinates?.[1]"));
  assert(pwa.includes("fetch(`${API}/communes?q="));
});

Deno.test("les parcours sensibles utilisent des dialogues accessibles", () => {
  assert(pwa.includes('id="dialogAction"'));
  assert(pwa.includes('id="dialogJeton"'));
  assertEquals(/(^|[^\w.])(?:prompt|confirm|alert)\s*\(/m.test(pwa), false);
});

Deno.test("les notifications sont limitées aux appareils Web Push", () => {
  assert(pwa.includes("Notifications sur vos appareils"));
  assert(pwa.includes("type: 'webpush'"));
  assertEquals(pwa.includes('id="btnEmail"'), false);
  assertEquals(pwa.includes('id="btnTelegram"'), false);
  assertEquals(pwa.includes('id="dialogEmail"'), false);

  assert(api.includes('body.type !== "webpush"'));
  assert(api.includes('.eq("type", "webpush")'));
  assertEquals(dispatch.includes("SMTPClient"), false);
  assertEquals(dispatch.includes("envoyerTelegram"), false);
  assert(dispatch.includes('canal.type !== "webpush"'));
  assert(signalement.includes('.select("type, actif, verifie")'));

  assert(migrationNotifications.includes("delete from public.canaux"));
  assert(migrationNotifications.includes("type in ('email', 'telegram')"));
  assert(migrationNotifications.includes("check (type = 'webpush')"));
});

Deno.test("la carte s’actualise pour tous et respecte l’économie de données", () => {
  assert(pwa.includes("setInterval(actualiserDonnees, 120000)"));
  assert(pwa.includes("navigator.connection?.saveData === true"));
  assert(pwa.includes("actualisationEnCours"));
});

Deno.test("la console de modération ne persiste pas la clé administrateur", () => {
  assert(moderation.includes('id="cle" type="password"'));
  assert(moderation.includes("let cleAdmin=''"));
  assertEquals(moderation.includes("localStorage"), false);
  assertEquals(moderation.includes("sessionStorage"), false);
  assert(moderation.includes("'x-admin-key':cleAdmin"));
  assert(moderation.toLowerCase().includes("motif obligatoire"));
  assert(moderation.includes('id="dialogDecision"'));
  assertEquals(
    /(^|[^\w.])(?:prompt|confirm|alert)\s*\(/m.test(moderation),
    false,
  );
});
