# Contexte technique et mémoire du projet

Dernière revue globale : **26 juillet 2026**.

Ce fichier est la mémoire technique maintenue du projet. Il décrit l'état
réel du dépôt, les invariants à ne pas casser et les points qui doivent être
revérifiés lors d'une reprise. Le README reste la présentation fonctionnelle,
`EXPLOITATION.md` la procédure opérateur et `SECURITE.md` le modèle de menace.

## État de livraison connu

- Branche de référence : `main`.
- État Git constaté localement : `HEAD` sur `3ac2680`, une validation SQL en
  avance sur `origin/main` (`041bd44`). La correction de la migration 26 et la
  suppression de l'ancienne migration 28 ne sont donc pas encore sur le dépôt
  distant ; aucun déploiement distant ne peut les appliquer dans cet état.
- Schéma du dépôt : migrations **01 à 29**.
- Dernier état de production communiqué : migrations **01 à 22** appliquées ;
  migrations **23 à 28** encore en attente.
- La migration 28 intitulée `retire_interrupteur_homme_mort` a été retirée :
  elle ne doit pas réapparaître. Le numéro 28 est désormais porté par la
  migration distincte `conformite_moderation_audit`.
- Le run GitHub Actions `30203157669` du commit distant `041bd44` a passé lint,
  typage et tests, puis Docker a démarré correctement. Le rejeu a échoué dans la
  migration 26 sur une erreur de précédence (`command ~ (...)`) ; le déploiement
  a donc été sauté. La correction existe dans le dépôt local, pas encore sur
  `origin/main`.
- Le workflow PWA échoue séparément dans `actions/configure-pages` parce que
  GitHub Pages n'est pas encore activé et configuré avec « GitHub Actions »
  comme source de publication.
- Le dernier run de déploiement antérieur au vérificateur montrait les trois
  secrets GitHub Actions Supabase vides. Avant le prochain déploiement, vérifier
  `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF` et
  `SUPABASE_DB_PASSWORD`.
- Le rejeu local est désormais borné à 15 minutes dans GitHub Actions et le job
  de déploiement signale explicitement lequel des trois secrets manque.
- Validation locale du 26 juillet 2026 avec Docker Desktop et Supabase CLI
  2.109.1 : les **29 migrations** se rejouent intégralement sur une base neuve.
  Le conteneur Postgres est sain, les 11 tâches `pg_cron` sont présentes, toutes
  les tables publiques ont RLS active sans aucune policy publique, et les deux
  contacts RGPD valent `qevedeveq@gmail.com`. Cette validation locale ne change
  pas l'état de production, toujours connu jusqu'à la migration 22.

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
                                          /      |       \
                                      Web Push Telegram  e-mail
```

La PWA statique appelle uniquement `api` et `signalement`. Toutes les tables
ont RLS active sans policy publique ; les Edge Functions utilisent le service
role et appliquent les contrôles applicatifs.

## Modules Edge

| Fonction | Responsabilité | Accès |
|---|---|---|
| `api` | carte corrélée, inscription consentie, état, zones, canaux, export et suppression du compte | carte et routes publiques limitées, sinon `x-token` |
| `signalement` | création, carte et contestation collective des signalements | carte publique limitée ; écriture par `x-token` et canal vérifié |
| `poll-firms` | collecte VIIRS/MODIS et agrégation | admin ou service role |
| `poll-lsasaf` | collecte Meteosat HDF5 | admin ou service role |
| `poll-meteo` | vent, humidité, température et risque | admin ou service role |
| `poll-adsb` | aéronefs de lutte et corroboration | admin ou service role, désactivé par défaut |
| `dispatch` | reprise et envoi Web Push, Telegram, SMTP | admin ou service role |
| `load-communes` | cache des contours communaux | admin ou service role |
| `probe-lsasaf` | diagnostic manuel du décodeur HDF5 | admin |
| `probe-mtg` | veille mensuelle sur le produit MTG | admin ou service role |

## Domaines de données

| Domaine | Tables principales |
|---|---|
| Géographie | `communes`, `zones`, `zone_abonnes` |
| Abonnements | `abonnes`, `canaux` |
| Satellites | `detections`, `sources_permanentes`, `creneaux_traites` |
| Témoins | `signalements`, `signalement_groupes`, `signalement_contestations` |
| Fusion | `evenements`, `evenement_detections` |
| Notification | `alertes` |
| Enrichissement | `meteo`, `observations_aero` |
| Exploitation | `runs`, `config`, `quotas`, `audit_admin` |

## Planification déclarative

La migration 26 est la source de vérité des tâches `pg_cron`.

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

Quand l'ADS-B est actif, `poll-adsb` purge aussi les observations aériennes de
plus de 24 heures.

## Invariants à préserver

- Une preuve citoyenne ne compte jamais comme un pixel satellite.
- Toute création ou contestation citoyenne exige un compte actif avec au moins
  un canal actif et vérifié ; le jeton d'abonné seul est insuffisant.
- Un signalement confirmé seul reste au maximum `alerte`; `critique` exige une
  corroboration automatique ou les règles satellite.
- L'ADS-B ne crée jamais d'événement et exige deux positions récentes du même
  appareil à moins de 4 km.
- La météo ne peut que durcir la sensibilité, jamais la relâcher.
- Une alerte est idempotente par événement, canal, sévérité et type.
- Les échecs d'envoi sont retentés avec temporisation puis le canal est
  désactivé après cinq échecs.
- Les canaux e-mail exigent un double opt-in. Telegram est créé uniquement par
  le webhook `/start`; la route générique `canal` ne l'accepte pas.
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
- Le webhook Telegram exige `config.telegram_webhook_secret`, généré par la
  migration 28 et transmis à Telegram lors de `setWebhook`.
- La carte regroupe les pixels dans un rayon de 2 km et ne compte qu'une fois
  chaque famille indépendante : polaire, géostationnaire, citoyenne et aérienne.
  Son score est indicatif et ne doit jamais être présenté comme une
  confirmation officielle.

## Limites et risques connus

1. **Angle mort interne.** `verifier_sante()` vit dans Supabase. Un projet en
   pause, une panne de la base ou l'arrêt de `pg_cron` ne produisent aucune
   alerte. Il n'existe volontairement plus de veilleur externe.
2. **Jeton porteur.** Le jeton d'abonné est conservé dans `localStorage`.
   Quiconque le récupère contrôle les zones et canaux de cet abonné.
3. **Réputation non décisionnelle.** L'export expose un historique agrégé
   (confirmés, corroborés, rejetés), mais ce score n'influence pas encore le
   poids d'un futur signalement.
4. **Dépendances externes.** NASA FIRMS, LSA SAF, Open-Meteo, OpenSky,
   geo.api.gouv.fr, Telegram et le fournisseur SMTP restent des points de
   dégradation.
5. **Ouverture large non prête.** La politique et les droits techniques sont
   présents et le contact public `qevedeveq@gmail.com` est livré par la
   migration 28. L'identité légale complète du responsable, un expéditeur
   e-mail transactionnel et les textes doivent encore être validés avant
   communication large.
6. **Endpoint Supabase lié au déploiement.** La PWA contient actuellement la
   référence du projet dans `web/index.html`; tout changement de projet exige
   sa mise à jour.
7. **Couverture nationale partielle.** La collecte et la carte automatiques
   couvrent la métropole et la Corse, plus l'enveloppe des zones abonnées. Les
   flux Europe ne garantissent pas encore une couverture automatique homogène
   de tous les territoires ultramarins. La route publique est bornée à 500
   groupes et 72 h ; l'interface anonyme complète reste à livrer.
8. **Montée en charge non démontrée.** Le chargement de toutes les communes est
   prévu, mais les volumes d'une carte nationale, les quotas publics et les
   coûts de notification n'ont pas encore été testés.
9. **FeuxDeForet.fr non intégré.** Aucune API publique documentée n'a été
   identifiée et les CGU interdisent l'extraction/réutilisation substantielle
   sans autorisation écrite. La PWA fournit un lien complémentaire ; aucune
   donnée n'est copiée tant qu'un contrat et un schéma de flux partenaire
   vérifiable ne sont pas disponibles.

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
