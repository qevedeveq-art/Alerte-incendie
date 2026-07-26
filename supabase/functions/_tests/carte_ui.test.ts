import { assert, assertEquals } from "./assert.ts";

const pwa = await Deno.readTextFile("../../web/index.html");

Deno.test("la carte utilise la vue satellite IGN par défaut", () => {
  const ajoutSatellite = pwa.indexOf("ORTHOIMAGERY.ORTHOPHOTOS");
  const ajoutCarte = pwa.indexOf(").addTo(carte);", ajoutSatellite);
  assert(ajoutSatellite >= 0);
  assert(ajoutCarte > ajoutSatellite);
  assert(pwa.includes("'Vue satellite (IGN)': satellite"));
  assert(pwa.includes("'Plan sombre': planSombre"));
});

Deno.test("la légende française distingue les statuts de preuve", () => {
  for (
    const libelle of [
      "Au moins 2 familles indépendantes",
      "Signal unique fort ou répété",
      "Indice automatique isolé",
      "Déclarations citoyennes vérifiées",
      "Déclaration non vérifiée",
    ]
  ) {
    assert(pwa.includes(libelle), `Libellé absent : ${libelle}`);
  }
});

Deno.test("les feux fiables sont des flammes et seul le non vérifié reste gris", () => {
  assert(pwa.includes("function svgFlamme("));
  assert(pwa.includes("L.marker([f.lat, f.lon]"));
  assert(pwa.includes("const c = '#8a8a8a';"));
  assert(pwa.includes("familles >= 2 ? 'corrobore'"));
  assert(pwa.includes("score >= 60 || puissance >= 50 || observations >= 3"));
  assertEquals(
    pwa.includes("const c = s.confirme ? '#e9873a' : '#8a8a8a'"),
    false,
  );
});

Deno.test("la carte explique les preuves et sépare les sources contextuelles", () => {
  assert(pwa.includes("Voir les preuves et l’incertitude"));
  assert(pwa.includes("Contexte EFFIS"));
  assert(pwa.includes("Météo des forêts officielle"));
  assert(pwa.includes("Il ne décrit ni le périmètre ni la surface brûlée."));
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
