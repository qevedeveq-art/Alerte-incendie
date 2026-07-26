// =====================================================================
//  Module partagé par toutes les Edge Functions.
// ---------------------------------------------------------------------
//  Les secrets (clés VAPID et clé d'administration) vivent dans la table
//  public.config plutôt que dans
//  des variables d'environnement : cela permet de les modifier sans
//  redéployer, et la table est inaccessible hors service role (RLS
//  active, aucune policy).
// =====================================================================
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { comparerSecret } from "./format.ts";

export const sb: SupabaseClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

let cc: Record<string, any> | null = null, ca = 0;

/** Configuration applicative, mise en cache 30 s. */
export async function config(force = false): Promise<Record<string, any>> {
  if (!force && cc && Date.now() - ca < 30_000) return cc;
  const { data, error } = await sb.from("config").select("k,v");
  if (error) throw new Error(`config: ${error.message}`);
  const frais: Record<string, any> = Object.fromEntries((data ?? []).map((r) => [r.k, r.v]));
  if (!cc || JSON.stringify(cc) !== JSON.stringify(frais)) configVersion++;
  cc = frais;
  ca = Date.now();
  return frais;
}

/** Version de la configuration : change à chaque rechargement effectif.
 *  Permet au cache dérivé du serveur Web Push de savoir
 *  qu'ils doivent être reconstruits, sans quoi une rotation de secret
 *  exigerait un redéploiement — ce que la table config est justement
 *  censée éviter. */
export let configVersion = 0;

/** Vide le cache de configuration. */
export function invaliderConfig() {
  cc = null;
  ca = 0;
}

/** Comparaison à temps constant contre config.admin_key. */
export async function verifierAdmin(req: Request): Promise<boolean> {
  // Jamais dans l'URL : les query strings finissent couramment dans les logs,
  // historiques et en-têtes Referer.
  const f = req.headers.get("x-admin-key") ?? "";
  const a = String((await config()).admin_key ?? "");
  return comparerSecret(f, a);
}

/** Appel interne depuis une autre Edge Function (porteur du service role). */
export function estInterne(req: Request): boolean {
  // Pas de clé de service : aucune requête ne peut être « interne ».
  // La version précédente repliait sur une sentinelle, ce qui obligeait à
  // choisir une valeur qu'aucun en-tête ne contient — un espace, par
  // exemple, aurait rendu vraie toute requête portant un Authorization.
  // Un simple refus est plus sûr et plus lisible.
  const srk = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!srk) return false;
  return comparerSecret(req.headers.get("Authorization") ?? "", `Bearer ${srk}`);
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-admin-key, x-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

/** Les datasets HDF5 entiers arrivent parfois en BigInt, que JSON.stringify refuse. */
export function json(body: unknown, status = 200) {
  const texte = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
  return new Response(texte, {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

export async function ouvrirRun(kind: string): Promise<number | null> {
  const { data } = await sb.from("runs").insert({ kind }).select("id").single();
  return data?.id ?? null;
}

export async function fermerRun(
  id: number | null,
  ok: boolean,
  stats: unknown,
  erreur?: string,
) {
  if (id == null) return;
  await sb.from("runs").update({
    finished_at: new Date().toISOString(),
    ok,
    stats,
    erreur: erreur ? String(erreur).slice(0, 2000) : null,
  }).eq("id", id);
}

// ---------------------------------------------------------------------
//  Anti-abus
// ---------------------------------------------------------------------

/** Adresse de l'appelant, telle que vue par la passerelle Supabase. */
export function ipAppelant(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] || req.headers.get("cf-connecting-ip") || "inconnue").trim();
}

/** Autorise une opération d'exploitation et journalise l'usage d'admin_key.
 *  Les appels internes porteurs du service role restent distingués et ne
 *  polluent pas le journal des actions humaines. */
export async function autoriserOperation(
  req: Request,
  action: string,
  accepterInterne = true,
): Promise<boolean> {
  if (accepterInterne && estInterne(req)) return true;
  if (!await verifierAdmin(req)) return false;

  try {
    const cfg = await config();
    const brut = `${ipAppelant(req)}|${String(cfg.sel_ip ?? "")}`;
    const empreinte = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(brut));
    const ipHash = [...new Uint8Array(empreinte)]
      .map((x) => x.toString(16).padStart(2, "0")).join("");
    const { error } = await sb.from("audit_admin").insert({
      action: action.slice(0, 120),
      ip_hash: ipHash,
      user_agent: String(req.headers.get("user-agent") ?? "").slice(0, 300) || null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    // Une indisponibilité du journal ne doit pas bloquer une collecte ou une
    // intervention urgente ; elle reste visible dans les logs Edge.
    console.error("audit_admin", action, String(e));
  }
  return true;
}

/** Consomme un jeton de quota. Renvoie false si le plafond est atteint. */
export async function quota(cle: string, max: number, secondes: number): Promise<boolean> {
  const { data, error } = await sb.rpc("consommer_quota", {
    p_cle: cle,
    p_max: max,
    p_fenetre: `${secondes} seconds`,
  });
  if (error) return true; // en cas de panne du compteur, on ne bloque pas le service
  return data !== false;
}

export const TROP_DE_REQUETES = { erreur: "trop de requêtes, patientez quelques minutes" };

// Utilitaires purs : définis dans format.ts (sans dépendance à Supabase,
// donc testables hors environnement), réexportés ici par commodité.
export {
  aUnCanalVerifie,
  comparerSecret,
  empriseFranceEtZones,
  fetchRetry,
  normaliserAbonnementPush,
  secteurVent,
} from "./format.ts";
