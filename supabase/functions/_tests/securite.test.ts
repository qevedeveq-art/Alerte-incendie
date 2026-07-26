// =====================================================================
//  Tests des validations de sécurité pures.
// =====================================================================
import { assert, assertEquals } from "./assert.ts";
import { aUnCanalVerifie, comparerSecret, normaliserAbonnementPush } from "../_shared/format.ts";

Deno.test("Secrets — comparaison exacte et refus d'une valeur vide", () => {
  assert(comparerSecret("secret-solide", "secret-solide"));
  assertEquals(comparerSecret("secret-solide!", "secret-solide"), false);
  assertEquals(comparerSecret("secret-s0lide", "secret-solide"), false);
  assertEquals(comparerSecret("", ""), false);
});

const abonnement = (endpoint: string) => ({
  endpoint,
  expirationTime: null,
  keys: {
    p256dh: "B".repeat(65),
    auth: "A".repeat(16),
  },
});

Deno.test("Web Push — accepte un abonnement HTTPS structuré", () => {
  const v = normaliserAbonnementPush(abonnement("https://push.example.net/send/abc"));
  assert(v);
  assertEquals(v.endpoint, "https://push.example.net/send/abc");
});

Deno.test("Web Push — refuse HTTP et les hôtes locaux", () => {
  assertEquals(normaliserAbonnementPush(abonnement("http://push.example.net/x")), null);
  assertEquals(normaliserAbonnementPush(abonnement("https://localhost/x")), null);
  assertEquals(normaliserAbonnementPush(abonnement("https://127.0.0.1/x")), null);
  assertEquals(normaliserAbonnementPush(abonnement("https://[::1]/x")), null);
});

Deno.test("Web Push — refuse les clés absentes ou trop courtes", () => {
  assertEquals(
    normaliserAbonnementPush({
      endpoint: "https://push.example.net/x",
      keys: { p256dh: "court", auth: "" },
    }),
    null,
  );
});

Deno.test("Signalements — exige au moins un canal actif et vérifié", () => {
  assertEquals(aUnCanalVerifie(null), false);
  assertEquals(aUnCanalVerifie([]), false);
  assertEquals(aUnCanalVerifie([{ actif: true, verifie: false }]), false);
  assertEquals(aUnCanalVerifie([{ actif: false, verifie: true }]), false);
  assert(aUnCanalVerifie([
    { actif: true, verifie: false },
    { actif: true, verifie: true },
  ]));
});
