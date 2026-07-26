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
  assert(pwa.includes("const c = '#8a8a8a';"));
  assert(pwa.includes("familles >= 2 ? 'corrobore'"));
  assert(pwa.includes("score >= 60 || puissance >= 50 || observations >= 3"));
  assertEquals(
    pwa.includes("const c = s.confirme ? '#e9873a' : '#8a8a8a'"),
    false,
  );
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
  assert(pwa.includes("#map{height:max(410px,56vh)}"));
  assert(pwa.includes(".anonyme #vueApp{order:1}"));
  assert(pwa.includes('id="btnVoirCarte"'));
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
