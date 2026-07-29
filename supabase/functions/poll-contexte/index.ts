// =====================================================================
//  poll-contexte — collecteur et associateur de contexte local
// ---------------------------------------------------------------------
//  Associe aux feux actifs des communiqués officiels et articles locaux,
//  à titre de contexte sourcé.
//
//  INVARIANT INVIOLABLE : le contexte est une couche d'information
//  séparée. Il ne crée, ne corrobore, n'élève et ne clôt aucun
//  évènement. Il ne modifie ni la sévérité, ni le score de détection,
//  ni la file d'alertes. Cette fonction n'écrit que dans
//  mentions_contexte et evenement_mentions, via une seule RPC.
//
//  Répartition des responsabilités, volontaire :
//    - ici     : réseau, lecture des flux, dédoublonnage, filtre d'entrée
//                peu coûteux ;
//    - en base : contours communaux, distances, barème d'association et
//                décision (public.enregistrer_mention_contexte).
//
//  Publication : une source en mode « shadow » est collectée et évaluée,
//  mais ses associations restent « a_valider » et /api/contexte ne les
//  restitue pas. Le passage en mode « actif » est une décision humaine,
//  source par source, après validation juridique et mesure de précision
//  (porte de sortie du lot 2 de docs/ETAPE_ACTUALITES_LOCALES.md).
//
//  Cadence : toutes les 30 minutes (pg_cron).
// =====================================================================
import {
  adresseReseauInterdite,
  autoriserOperation,
  CORS,
  fermerRun,
  fetchRetry,
  json,
  ouvrirRun,
  sb,
} from "../_shared/mod.ts";
import {
  ARTICLES_MAX,
  contientVocabulaireFeu,
  empreinteMention,
  extraireArticles,
  TAILLE_MAX_FLUX,
} from "./flux.ts";

/** Nombre de flux lus par passage. Borne le temps d'exécution et la
 *  charge sur des serveurs amont qui nous rendent service gratuitement. */
const SOURCES_MAX = 20;

/** Un flux lent ne doit pas consommer le créneau des suivants. */
const TIMEOUT_FLUX_MS = 10_000;

interface Bilan {
  sources_lues: number;
  sources_en_echec: number;
  articles_lus: number;
  articles_retenus: number;
  mentions: number;
  liens: number;
  associes: number;
}

/** Refuse ce qui n'est pas une URL publique en https : une Edge Function
 *  qui suit une adresse privée devient un relais vers le réseau interne. */
export function urlAutorisee(urlStr: string | null | undefined): boolean {
  if (!urlStr) return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return !(
      h === "localhost" || h.endsWith(".local") || h.startsWith("127.") ||
      h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":")
    );
  } catch {
    return false;
  }
}

/** Vérifie aussi la résolution DNS avant chaque requête et redirection. */
async function urlPubliqueResolue(urlStr: string): Promise<boolean> {
  if (!urlAutorisee(urlStr)) return false;
  const hote = new URL(urlStr).hostname;
  try {
    const [ipv4, ipv6] = await Promise.all([
      Deno.resolveDns(hote, "A").catch(() => [] as string[]),
      Deno.resolveDns(hote, "AAAA").catch(() => [] as string[]),
    ]);
    const adresses = [...ipv4, ...ipv6];
    return adresses.length > 0 && adresses.every((ip) => !adresseReseauInterdite(ip));
  } catch {
    return false;
  }
}

async function chargerFlux(urlInitiale: string): Promise<Response> {
  let courante = urlInitiale;
  for (let redirections = 0; redirections <= 3; redirections++) {
    if (!await urlPubliqueResolue(courante)) {
      throw new Error("URL de flux non publique");
    }
    const res = await fetchRetry(
      courante,
      {
        headers: { accept: "application/rss+xml, application/atom+xml, application/xml" },
        redirect: "manual",
      },
      2,
      TIMEOUT_FLUX_MS,
    );
    if (res.status < 300 || res.status >= 400) return res;
    const destination = res.headers.get("location");
    if (!destination) throw new Error("redirection sans destination");
    courante = new URL(destination, courante).toString();
  }
  throw new Error("trop de redirections");
}

async function purger(): Promise<void> {
  const { error } = await sb.rpc("purger_contexte_local");
  if (error) console.error("poll-contexte purge", error.message);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ erreur: "méthode non autorisée" }, 405);
  if (!await autoriserOperation(req, "poll-contexte")) {
    return json({ erreur: "non autorisé" }, 401);
  }

  const runId = await ouvrirRun("poll-contexte");
  const bilan: Bilan = {
    sources_lues: 0,
    sources_en_echec: 0,
    articles_lus: 0,
    articles_retenus: 0,
    mentions: 0,
    liens: 0,
    associes: 0,
  };

  try {
    // 1. Sources activées. Une source désactivée n'est jamais contactée :
    //    c'est l'arrêt par source exigé par le plan.
    const { data: sources, error: erreurSources } = await sb
      .from("sources_contexte")
      .select("code, nom, type, url_flux, mode, actif")
      .eq("actif", true)
      .neq("mode", "desactive")
      .limit(SOURCES_MAX);
    if (erreurSources) throw new Error(erreurSources.message);

    if (!sources || sources.length === 0) {
      await purger();
      await fermerRun(runId, true, { message: "aucune source activée", ...bilan });
      return json({ ok: true, sources_actives: 0, ...bilan });
    }

    // 2. Sans feu actif, il n'y a rien à contextualiser : on ne sollicite
    //    pas les serveurs amont pour rien.
    const { count: nbEvenements } = await sb
      .from("evenements")
      .select("id", { count: "exact", head: true })
      .eq("statut", "actif")
      .gte("derniere_maj", new Date(Date.now() - 72 * 3_600_000).toISOString());

    if (!nbEvenements) {
      await purger();
      await fermerRun(runId, true, { message: "aucun évènement actif", ...bilan });
      return json({ ok: true, evenements_actifs: 0, ...bilan });
    }

    // 3. Lecture des flux, puis délégation du rattachement à la base.
    for (const source of sources) {
      if (!urlAutorisee(source.url_flux)) continue;

      let xml: string;
      try {
        const res = await chargerFlux(source.url_flux as string);
        if (!res.ok) {
          bilan.sources_en_echec++;
          continue;
        }
        xml = (await res.text()).slice(0, TAILLE_MAX_FLUX);
      } catch {
        bilan.sources_en_echec++;
        continue;
      }

      bilan.sources_lues++;
      const articles = extraireArticles(xml, ARTICLES_MAX);
      bilan.articles_lus += articles.length;

      for (const article of articles) {
        if (!contientVocabulaireFeu(`${article.titre} ${article.resume ?? ""}`)) continue;
        bilan.articles_retenus++;

        const hash = await empreinteMention(String(source.code), article.url, article.titre);
        const { data, error } = await sb.rpc("enregistrer_mention_contexte", {
          p_source_code: source.code,
          p_externe_hash: hash,
          p_url: article.url,
          p_titre: article.titre,
          p_resume: article.resume,
          p_date_publication: (article.publie ?? new Date()).toISOString(),
          p_lat: null,
          p_lon: null,
        });
        if (error) {
          console.error("poll-contexte association", error.message);
          continue;
        }
        if (data?.ok) {
          bilan.mentions++;
          bilan.liens += Number(data.liens ?? 0);
          bilan.associes += Number(data.associes ?? 0);
        }
      }
    }

    // 4. Rétention : candidates non associées, rejetées et audit ancien.
    await purger();

    await fermerRun(runId, true, { ...bilan });
    return json({ ok: true, ...bilan });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await fermerRun(runId, false, { erreur: msg, ...bilan });
    return json({ ok: false, erreur: msg }, 500);
  }
});
