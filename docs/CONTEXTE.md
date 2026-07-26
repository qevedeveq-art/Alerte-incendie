# Contexte technique et mémoire du projet

Dernière revue globale : **26 juillet 2026**.

Ce fichier est la mémoire technique maintenue du projet. Il décrit l'état
réel du dépôt, les invariants à ne pas casser et les points qui doivent être
revérifiés lors d'une reprise. Le README reste la présentation fonctionnelle,
`EXPLOITATION.md` la procédure opérateur et `SECURITE.md` le modèle de menace.

## État de livraison connu

- Branche de référence : `main`.
- État fonctionnel publié : commit `ebceaf6` sur `main` et `origin/main`.
- Schéma du dépôt : migrations **01 à 35**.
- État de production vérifié : migrations **01 à 35** appliquées et Edge
  Functions déployées.
- La migration 28 intitulée `retire_interrupteur_homme_mort` a été retirée :
  elle ne doit pas réapparaître. Le numéro 28 est désormais porté par la
  migration distincte `conformite_moderation_audit`.
- Le run GitHub Actions `30206844189` du commit `689596d` a passé formatage,
  lint, typage, 28 tests unitaires et le rejeu Docker intégral des 29
  migrations. Après ajout des trois secrets Actions, la relance manuelle
  « Déployer Supabase » a réussi. Contrôle externe effectué le 26 juillet :
  `GET /functions/v1/api/carte?heures=24&limite=5` répond HTTP 200 et expose
  les quatre familles `polaire`, `geostationnaire`, `citoyen`, `aerien`.
- GitHub Pages est activé avec « GitHub Actions » comme source. Le workflow
  « Publier la PWA #5 » du commit `af21815` a réussi ; contrôle externe effectué
  le 26 juillet : `https://qevedeveq-art.github.io/Alerte-incendie/` répond
  HTTP 200 et contient la carte corrélée, ses filtres et la page de
  confidentialité.
- Les secrets `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` et
  `SUPABASE_DB_PASSWORD` sont désormais configurés dans GitHub Actions.
- Le rejeu local est désormais borné à 15 minutes dans GitHub Actions et le job
  de déploiement signale explicitement lequel des trois secrets manque.
- Validation locale du 26 juillet 2026 avec Docker Desktop et Supabase CLI
  2.109.1 : les **35 migrations** se rejouent intégralement sur une base neuve.
  Le conteneur Postgres est sain, les 12 tâches `pg_cron` sont présentes, toutes
  les tables publiques ont RLS active sans aucune policy publique, et les deux
  contacts RGPD valent `qevedeveq@gmail.com`.
- Le run « Publier la PWA » `30209289005` du commit `b9d1ee8` a réussi. Le run
  Supabase `30209289053` a rencontré un timeout réseau vers le pooler lors de
  sa première tentative, puis sa seconde tentative a appliqué les migrations
  30 à 33 et déployé les 11 Edge Functions avec succès.
- Contrôle externe après déploiement : la PWA répond HTTP 200 avec le fond
  satellite et le formulaire structuré ; `/api/sante-publique` répond HTTP 200
  avec `ok=true`, collecte polaire, Meteosat et `pg_cron` opérationnels. La
  carte de production renvoie 110 groupes : 1 corroboré multi-familles, 59
  probables forts ou répétés et 50 indices isolés.
- Livraison `ebceaf6` : refonte carte-first responsive,
  clustering neutre, filtres 1/6/24 h et confiance, liste synchronisée, fiche
  incident partageable, recherche publique commune/code postal, résumé local,
  parcours d'alerte recommandé automatisé, formulaires accessibles,
  actualisation périodique, installation/hors-ligne et console opérateur. La
  migration 34 ajoute les RPC de modération sans donnée d'identité. La
  migration 35 retire temporairement e-mail et Telegram, efface leurs
  destinations et secrets, clôt leurs envois en attente et impose
  `canaux.type = 'webpush'`. L'interface et les Edge Functions ne proposent
  désormais que les notifications sur appareil. Validation locale : 35
  migrations rejouées sur une base neuve, schéma `public` sans erreur de lint,
  contrainte présente, aucun ancien canal/secret et 40 tests Deno réussis.
- Le run PWA `30213328072` et le run Supabase `30213328073` du commit
  `ebceaf6` ont réussi. Ce dernier a rejoué les 35 migrations, appliqué les
  migrations 34–35 en production puis déployé toutes les Edge Functions.
  Contrôle externe : PWA HTTP 200 avec parcours appareil uniquement, aucun
  bouton e-mail/Telegram, `/api/sante-publique` HTTP 200 avec `ok=true` et
  l'ancien webhook Telegram répond sans créer de canal (`actif=false`).

Après chaque déploiement réussi, mettre cette section à jour avec la dernière
migration effectivement présente en production.

## Vue d'ensemble

Le système combine trois familles de preuves :

1. signalements citoyens, instantanés mais non vérifiés ;
2. Meteosat/SEVIRI via LSA SAF, environ 25 minutes de latence et 3 km de
   résolution ;
3. VIIRS/MODIS via NASA FIRMS, 2 à 3 heures de latence et 375 m à 1 km de
   résolution.

Open-Meteo enrichit les alertes avec le vent et peut uniquement augmenter la
sensibilité. L'ADS-B peut corroborer un événement existant mais ne crée jamais
un feu à lui seul.

```text
NASA FIRMS ──> poll-firms ─────┐
LSA SAF ─────> poll-lsasaf ────┼─> detections ─> traiter_detections()
Citoyens ────> signalement ────┘       │              │
                                      └─> feux_carte() ─> carte corrélée
OpenSky ─────> poll-adsb ─> corroboration             v
Open-Meteo ──> poll-meteo ─> meteo              evenements
                                                     │
                                                     v
                                             file public.alertes
                                                     │
                                                     v
                                              dispatch
                                                  │
                                                  v
                                              Web Push
```

La PWA statique appelle uniquement `api` et `signalement`. Toutes les tables
ont RLS active sans policy publique ; les Edge Functions utilisent le service
role et appliquent les contrôles applicatifs.

## Modules Edge

| Fonction | Responsabilité | Accès |
|---|---|---|
| `api` | carte corrélée, inscription consentie, état, zones, canaux, export et suppression du compte | carte et routes publiques limitées, sinon `x-token` |
| `signalement` | création, carte, contestation et modération des signalements | carte publique limitée ; écriture par `x-token` vérifié ; modération par `admin_key` auditée |
| `poll-firms` | collecte VIIRS/MODIS et agrégation | admin ou service role |
| `poll-lsasaf` | collecte Meteosat HDF5 | admin ou service role |
| `poll-meteo` | vent, humidité, température et risque | admin ou service role |
| `poll-adsb` | aéronefs de lutte et corroboration | admin ou service role, désactivé par défaut |
| `dispatch` | reprise et envoi Web Push vers les appareils | admin ou service role |
| `load-communes` | cache des contours communaux | admin ou service role |
| `probe-lsasaf` | diagnostic manuel du décodeur HDF5 | admin |
| `probe-mtg` | veille mensuelle sur le produit MTG | admin ou service role |
| `probe-sentinel3` | cherche une collection SLSTR FRP NRT stable dans le STAC CDSE | admin ou service role |

## Domaines de données

| Domaine | Tables principales |
|---|---|
| Géographie | `communes`, `zones`, `zone_abonnes` |
| Abonnements | `abonnes`, `canaux` |
| Satellites | `detections`, `sources_permanentes`, `creneaux_traites` |
| Témoins | `signalements`, `signalement_groupes`, `signalement_contestations`, `signalement_moderation_audit` |
| Fusion | `evenements`, `evenement_detections` |
| Notification | `alertes` |
| Enrichissement | `meteo`, `observations_aero` |
| Exploitation | `runs`, `config`, `quotas`, `audit_admin` |

## Planification déclarative

Les migrations 26 et 32 sont la source de vérité des tâches `pg_cron`.

| Tâche | Cadence | Fonction |
|---|---:|---|
| `poll-firms` | toutes les 10 min | collecte polaire |
| `poll-lsasaf` | toutes les 15 min | collecte géostationnaire |
| `poll-meteo` | minutes 5 et 35 | météo |
| `poll-adsb` | toutes les 5 min | corroboration facultative |
| `dispatch` | toutes les 2 min | file d'envoi |
| `verifier-sante` | toutes les 15 min | collecte muette et perte géostationnaire |
| `clore-signalements` | minute 25 | expiration des groupes citoyens |
| `notifier-fin` | minutes 10 et 40 | fin d'alerte après 3 h |
| `purger` | 03:15 | rétention des données |
| `autotest-canaux` | 1er du mois à 09:00 | test des canaux inactifs |
| `probe-mtg` | 1er du mois à 04:30 | veille MTG |
| `probe-sentinel3` | 1er du mois à 04:45 | veille catalogue Sentinel-3 |

Quand l'ADS-B est actif, `poll-adsb` purge aussi les observations aériennes de
plus de 24 heures.

## Invariants à préserver

- Une preuve citoyenne ne compte jamais comme un pixel satellite.
- Toute création ou contestation citoyenne exige un compte actif avec au moins
  un appareil Web Push actif et vérifié ; le jeton d'abonné seul est insuffisant.
- Un signalement confirmé seul reste au maximum `alerte`; `critique` exige une
  corroboration automatique ou les règles satellite.
- L'ADS-B ne crée jamais d'événement et exige deux positions récentes du même
  appareil à moins de 4 km.
- La météo ne peut que durcir la sensibilité, jamais la relâcher.
- Une alerte est idempotente par événement, canal, sévérité et type.
- Les échecs d'envoi sont retentés avec temporisation puis le canal est
  désactivé après cinq échecs.
- Seuls les canaux `webpush` sont autorisés. La migration 35 supprime les
  destinations e-mail/Telegram historiques et une contrainte de base empêche
  leur recréation. Les routes historiques répondent sans activer de canal.
- Aucune fonction ou table métier n'est exécutable par `PUBLIC`, `anon` ou
  `authenticated`.
- Les textes issus du serveur sont échappés avant insertion dans le HTML de la
  PWA.
- Une inscription enregistre la version des conditions acceptées. L'abonné peut
  exporter ou supprimer ses données depuis la PWA.
- Une contestation citoyenne ne peut pas provenir d'un auteur du groupe et
  exige le même quorum que sa confirmation.
- Tout appel humain avec `admin_key` est journalisé avec une IP hachée ; les
  appels internes porteurs du service role ne le sont pas.
- La carte regroupe les pixels dans un rayon de 2 km et ne compte qu'une fois
  chaque famille indépendante : polaire, géostationnaire, citoyenne et aérienne.
  Son score est indicatif et ne doit jamais être présenté comme une
  confirmation officielle.
- La carte utilise l'orthophotographie IGN/Géoplateforme par défaut et conserve
  le plan sombre comme repli. Les indices automatiques sont des flammes
  jaunes/orange/rouges, les groupes citoyens vérifiés des flammes violettes et
  seuls les signalements non vérifiés restent des points gris discontinus. La
  taille 1–3 combine score, FRP et répétition ; elle ne représente jamais une
  surface brûlée.
- `corrobore` exige au moins deux familles indépendantes. Une seule famille,
  même répétée ou très puissante, reste `probable`; VIIRS, MODIS et les
  différents satellites polaires ne se corroborent pas entre eux.
- Les changements de statut de modération sont append-only dans
  `signalement_moderation_audit`. Leur historique privé est accessible
  uniquement au porteur du jeton et d'un appareil Web Push vérifié.
- La console de modération ne reçoit ni identité, ni canal, ni empreinte réseau.
  La clé administrateur reste en mémoire de page, chaque lecture ou décision
  est auditée et toute décision humaine exige un motif.
- La géolocalisation « autour de moi » est traitée localement. Elle n'est
  envoyée au serveur que si l'abonné enregistre explicitement un point de
  référence.
- La recherche publique de commune ne transmet que le nom ou le code postal
  saisi et renvoie le centre public de la commune. Elle reste sous le quota
  existant de 60 requêtes par minute, n'envoie pas le jeton d'abonné et ne
  remplace pas la géolocalisation locale.

## Limites et risques connus

1. **Dépendance de la veille externe.** Le workflow GitHub couvre désormais le
   projet en pause et `pg_cron` arrêté toutes les cinq minutes. Son efficacité
   dépend des notifications Actions du mainteneur et de la disponibilité de
   GitHub ; il ne remplace pas un contrat de supervision.
2. **Jeton porteur.** Le jeton d'abonné est conservé dans `localStorage`.
   Quiconque le récupère contrôle les zones et appareils de cet abonné.
3. **Réputation non décisionnelle.** L'export expose un historique agrégé
   (confirmés, corroborés, rejetés), mais ce score n'influence pas encore le
   poids d'un futur signalement.
4. **Dépendances externes.** NASA FIRMS, LSA SAF, Open-Meteo, OpenSky,
   geo.api.gouv.fr et les fournisseurs Web Push des navigateurs restent des
   points de dégradation.
5. **Ouverture large non prête.** La politique et les droits techniques sont
   présents et le contact public `qevedeveq@gmail.com` est livré par la
   migration 28. L'identité légale complète du responsable et les textes
   doivent encore être validés avant communication large.
6. **Endpoint Supabase lié au déploiement.** La PWA contient actuellement la
   référence du projet dans `web/index.html`; tout changement de projet exige
   sa mise à jour.
7. **Couverture nationale partielle.** La collecte et la carte automatiques
   couvrent la métropole et la Corse, plus l'enveloppe des zones abonnées. Les
   flux Europe ne garantissent pas encore une couverture automatique homogène
   de tous les territoires ultramarins. La route publique est bornée à 500
   groupes et 72 h ; la carte anonyme est désormais livrée mais les volumes
   nationaux et ultramarins restent à qualifier.
8. **Montée en charge non démontrée.** Le chargement de toutes les communes est
   prévu, mais les volumes d'une carte nationale, les quotas publics et les
   coûts de notification n'ont pas encore été testés.
9. **FeuxDeForet.fr non intégré.** Aucune API publique documentée n'a été
   identifiée et les CGU interdisent l'extraction/réutilisation substantielle
   sans autorisation écrite. La PWA fournit un lien complémentaire ; aucune
   donnée n'est copiée tant qu'un contrat et un schéma de flux partenaire
   vérifiable ne sont pas disponibles.
10. **Fond cartographique externe.** La vue satellite dépend du WMTS public
    IGN/Géoplateforme. Après quatre erreurs de tuiles, la PWA bascule
    automatiquement sur le plan CARTO ; le mode économie de données le choisit
    dès l'ouverture. Les deux fournisseurs restent néanmoins externes.
11. **WMS EFFIS trop lent.** Le 26 juillet, le GetMap officiel n'a répondu ni
    dans Leaflet ni en 30 secondes. Il reste un lien contextuel et n'est pas
    chargé dans la carte critique.

Le plan priorisé de réduction de ces risques et d'intégration de nouvelles
sources est maintenu dans `docs/PLAN_AMELIORATION.md`.

## Matrice de mise à jour

| Changement | Fichiers à revoir |
|---|---|
| comportement utilisateur | `README.md`, `web/index.html`, tests |
| schéma ou règle SQL | nouvelle migration, ce fichier, `EXPLOITATION.md` |
| route, authentification ou donnée personnelle | `SECURITE.md`, ce fichier |
| source ou cadence | migration cron, `README.md`, `EXPLOITATION.md`, ce fichier |
| secret ou configuration | `EXPLOITATION.md`, `SECURITE.md`, `.gitignore` |
| déploiement réussi/échoué | section « État de livraison connu » |

## Validation

```bash
cd supabase/functions
deno task verif
cd ../..
supabase db start
git diff --check
```

Le pipeline GitHub vérifie le formatage, le lint, le typage, les tests unitaires
et le rejeu intégral des migrations avant `supabase db push` et le déploiement
des Edge Functions.

La migration 28 ajoute une rétention explicite : observations ADS-B 24 h,
quotas 2 jours, créneaux 7 jours, runs 30 jours, détections 90 jours, alertes et
audit administrateur 180 jours, signalements et événements clos 365 jours.
