// =====================================================================
//  Tests des analyseurs de flux.
// ---------------------------------------------------------------------
//  Les fixtures reproduisent la forme reelle des donnees amont, y
//  compris les fins de ligne CRLF et les champs vides, qui sont les
//  deux sources d'erreur silencieuse les plus courantes.
// =====================================================================
import { assertEquals } from "./assert.ts";
import {
  horodatage,
  nombreOuNull,
  normaliserConfiance,
  parserCsv,
} from "../poll-firms/parsers.ts";

const CSV_VIIRS = [
  "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
  "43.64900,1.31970,320.1,0.39,0.36,2026-07-26,1230,N,VIIRS,n,2.0NRT,295.4,12.7,D",
  "42.51000,-6.98000,367.8,0.45,0.41,2026-07-26,1230,N,VIIRS,h,2.0NRT,301.2,0,D",
  "41.10000,2.10000,301.0,0.40,0.37,2026-07-26,0030,N,VIIRS,l,2.0NRT,288.0,,N",
].join("\r\n");

Deno.test("parserCsv — accepte les fins de ligne CRLF", () => {
  const l = parserCsv(CSV_VIIRS);
  assertEquals(l.length, 3);
  assertEquals(l[0].latitude, "43.64900");
  // Sans gestion du CRLF, la dernière colonne conserve un \r.
  assertEquals(l[0].daynight, "D");
});

Deno.test("parserCsv — ignore les lignes tronquées", () => {
  const l = parserCsv("a,b,c\n1,2,3\n4,5\n6,7,8");
  assertEquals(l.length, 2);
});

Deno.test("parserCsv — entrée vide ou sans données", () => {
  assertEquals(parserCsv(""), []);
  assertEquals(parserCsv("a,b,c"), []);
});

Deno.test("normaliserConfiance — VIIRS littéral et MODIS numérique", () => {
  assertEquals(normaliserConfiance("l"), 20);
  assertEquals(normaliserConfiance("nominal"), 60);
  assertEquals(normaliserConfiance("H"), 90);
  assertEquals(normaliserConfiance("73"), 73);
  assertEquals(normaliserConfiance(""), null);
  assertEquals(normaliserConfiance("bruit"), null);
});

Deno.test("horodatage — reconstruit un instant UTC valide", () => {
  assertEquals(horodatage("2026-07-26", "1230"), "2026-07-26T12:30:00Z");
  // acq_time perd ses zéros de tête dans le flux amont.
  assertEquals(horodatage("2026-07-26", "30"), "2026-07-26T00:30:00Z");
  assertEquals(horodatage("2026-07-26", "0"), "2026-07-26T00:00:00Z");
  assertEquals(
    new Date(horodatage("2026-07-26", "1230")).toISOString(),
    "2026-07-26T12:30:00.000Z",
  );
});

// ---------------------------------------------------------------------
//  Regression : `Number(x) || null` transformait une FRP de 0 en null.
//  0 MW est une mesure, pas une absence de mesure.
// ---------------------------------------------------------------------
Deno.test("nombreOuNull — distingue zéro et valeur absente", () => {
  assertEquals(nombreOuNull("0"), 0);
  assertEquals(nombreOuNull("12.7"), 12.7);
  assertEquals(nombreOuNull(""), null);
  assertEquals(nombreOuNull(undefined), null);
  assertEquals(nombreOuNull("n/a"), null);
});

Deno.test("bout à bout — une ligne à FRP nulle conserve sa valeur", () => {
  const l = parserCsv(CSV_VIIRS);
  assertEquals(nombreOuNull(l[1].frp), 0);
  assertEquals(nombreOuNull(l[2].frp), null);
  assertEquals(normaliserConfiance(l[1].confidence), 90);
});
