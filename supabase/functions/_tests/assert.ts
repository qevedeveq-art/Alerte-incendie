// =====================================================================
//  Assertions minimales.
// ---------------------------------------------------------------------
//  Volontairement sans dependance externe : la chaine de tests d'un
//  systeme d'alerte ne doit pas dependre de la disponibilite d'un
//  registre distant au moment ou l'on veut livrer un correctif.
// =====================================================================

export function assert(cond: unknown, msg = "assertion échouée"): asserts cond {
  if (!cond) throw new Error(msg);
}

export function assertEquals<T>(reel: T, attendu: T, msg?: string) {
  const a = JSON.stringify(reel), b = JSON.stringify(attendu);
  if (a !== b) {
    throw new Error(msg ?? `attendu ${b}, obtenu ${a}`);
  }
}

export function assertStringIncludes(reel: string, morceau: string, msg?: string) {
  if (!String(reel).includes(morceau)) {
    throw new Error(msg ?? `« ${morceau} » absent de :\n${reel}`);
  }
}

