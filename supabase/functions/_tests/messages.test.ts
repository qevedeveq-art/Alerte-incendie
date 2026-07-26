// =====================================================================
//  Tests des messages d'alerte.
// ---------------------------------------------------------------------
//  Ces tests existent a cause d'un bug reel : le texte annoncait
//  « NASA FIRMS (VIIRS/MODIS), latence 2 a 3 h, resolution 375 m » sur
//  TOUTES les alertes, y compris geostationnaires (25 min, 3 km) et
//  citoyennes (instantanees, non verifiees). Le message decrivait une
//  source que l'alerte n'avait pas utilisee.
//
//  Ce qui suit verrouille la correspondance entre sources reelles et
//  avertissement affiche.
// =====================================================================
import { assert, assertEquals, assertStringIncludes } from "./assert.ts";
import {
  avertissement,
  capteursLisibles,
  corpsTelegram,
  corpsTexte,
  type Payload,
  phraseVent,
} from "../dispatch/messages.ts";
import { echapperMdV2, secteurVent } from "../_shared/format.ts";

function payload(p: Partial<Payload> = {}): Payload {
  return {
    zone: "Cornebarrieu",
    commune: "Cornebarrieu",
    dans_commune: true,
    distance_m: 1200,
    severite: "alerte",
    nb_detections: 2,
    frp_max: 31.4,
    sources: ["VIIRS_SNPP"],
    origine: "satellite",
    lat: 43.649,
    lon: 1.3197,
    debut_ts: "2026-07-26T10:30:00Z",
    evenement_id: "e1",
    ...p,
  };
}

Deno.test("avertissement — polaire seul annonce 2 à 3 h et 375 m", () => {
  const a = avertissement(payload({ sources: ["VIIRS_SNPP", "MODIS"] }));
  assertStringIncludes(a, "2 à 3 h");
  assertStringIncludes(a, "375 m");
  assert(!a.includes("25 minutes"), "ne doit pas annoncer la latence géostationnaire");
});

Deno.test("avertissement — géostationnaire seul annonce 25 min et 3 km", () => {
  const a = avertissement(payload({ sources: ["MSG_SEVIRI"] }));
  assertStringIncludes(a, "25 minutes");
  assertStringIncludes(a, "3 km");
  assert(!a.includes("375 m"), "ne doit pas annoncer la résolution polaire");
  assert(!a.includes("2 à 3 h"), "ne doit pas annoncer la latence polaire");
});

Deno.test("avertissement — citoyen seul est explicitement non vérifié", () => {
  const a = avertissement(payload({ sources: ["CITOYEN"], origine: "citoyen" }));
  assertStringIncludes(a, "NON VÉRIFIÉ");
  assert(!a.includes("375 m"));
  assert(!a.includes("25 minutes"));
});

Deno.test("avertissement — citoyen confirmé par satellite est le cas le plus fiable", () => {
  const a = avertissement(payload({ sources: ["CITOYEN", "VIIRS_NOAA20"], origine: "mixte" }));
  assertStringIncludes(a, "confirmé");
  assert(!a.includes("NON VÉRIFIÉ"));
});

Deno.test("avertissement — deux familles de capteurs le signalent", () => {
  const a = avertissement(payload({ sources: ["VIIRS_SNPP", "MSG_SEVIRI"] }));
  assertStringIncludes(a, "indépendants");
});

Deno.test("avertissement — rappelle toujours FR-Alert et le 18/112", () => {
  for (const s of [["VIIRS_SNPP"], ["MSG_SEVIRI"], ["CITOYEN"], []]) {
    assertStringIncludes(avertissement(payload({ sources: s })), "18/112");
  }
});

Deno.test("capteursLisibles — traduit les identifiants techniques", () => {
  assertEquals(capteursLisibles(["VIIRS_SNPP", "VIIRS_NOAA20"]), "VIIRS");
  assertEquals(capteursLisibles(["MSG_SEVIRI"]), "Meteosat");
  assertEquals(capteursLisibles(["CITOYEN"]), "témoins");
  assertEquals(capteursLisibles(["ADSB"]), "aéronefs de lutte");
  assertEquals(capteursLisibles([]), "n/d");
});

Deno.test("corpsTexte — un événement citoyen ne parle pas de points chauds satellite", () => {
  const t = corpsTexte(payload({
    sources: ["CITOYEN"],
    origine: "citoyen",
    nb_detections: 0,
    nb_signalements: 3,
    frp_max: null,
  }));
  assertStringIncludes(t, "3 témoin(s)");
  assert(!t.includes("point(s) chaud(s) satellite"));
});

Deno.test("corpsTexte — la distance personnelle prime sur celle du centre communal", () => {
  const t = corpsTexte(payload({ distance_perso_m: 800, ref_libelle: "la maison" }));
  assertStringIncludes(t, "0.8 km de la maison");
});

Deno.test("phraseVent — donne le secteur d'origine et le sens de propagation", () => {
  const v = phraseVent({
    vent_kmh: 20,
    rafales_kmh: 45,
    vent_deg: 270,
    temp_c: 33,
    humidite_pct: 25,
    risque: "eleve",
  });
  assertStringIncludes(v!, "secteur ouest");
  assertStringIncludes(v!, "45 km/h");
  assertStringIncludes(v!, "vers le est");
});

Deno.test("phraseVent — absente si la météo manque", () => {
  assertEquals(phraseVent(null), null);
  assertEquals(
    phraseVent({
      vent_kmh: null,
      rafales_kmh: null,
      vent_deg: 90,
      temp_c: null,
      humidite_pct: null,
      risque: null,
    }),
    null,
  );
});

Deno.test("secteurVent — les huit secteurs et le bouclage à 360°", () => {
  assertEquals(secteurVent(0), "nord");
  assertEquals(secteurVent(360), "nord");
  assertEquals(secteurVent(45), "nord-est");
  assertEquals(secteurVent(180), "sud");
  assertEquals(secteurVent(315), "nord-ouest");
  assertEquals(secteurVent(null), null);
});

// ---------------------------------------------------------------------
//  Telegram : le mode Markdown historique rejetait tout message
//  contenant un caractère spécial non apparié. Un nom de commune avec
//  un tiret ou une parenthèse suffisait à faire échouer l'envoi, donc
//  à perdre l'alerte.
// ---------------------------------------------------------------------
Deno.test("echapperMdV2 — échappe tous les caractères réservés", () => {
  assertEquals(echapperMdV2("Saint-Jean (Haute-Garonne)"), "Saint\\-Jean \\(Haute\\-Garonne\\)");
  assertEquals(echapperMdV2("a_b*c"), "a\\_b\\*c");
  assertEquals(echapperMdV2("fin."), "fin\\.");
});

Deno.test("corpsTelegram — un nom de commune à tiret ne casse pas le balisage", () => {
  const t = corpsTelegram(payload({ commune: "Saint-Jean", zone: "Saint-Jean" }));
  assertStringIncludes(t, "Saint\\-Jean");
  // Toute astérisque restante doit être un délimiteur voulu, donc en nombre pair.
  const etoiles = (t.match(/(?<!\\)\*/g) ?? []).length;
  assertEquals(etoiles % 2, 0, "délimiteurs gras non appariés");
});
