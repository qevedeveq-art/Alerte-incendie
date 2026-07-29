# Contexte technique et mémoire du projet

Dernière revue globale : **29 juillet 2026**.

Ce fichier est la mémoire technique maintenue du projet. Il décrit l'état
réel du dépôt, les invariants à ne pas casser et les points qui doivent être
revérifiés lors d'une reprise. Le README reste la présentation fonctionnelle,
`EXPLOITATION.md` la procédure opérateur et `SECURITE.md` le modèle de menace.

## État de livraison connu

- Branche de référence : `main`.
- État fonctionnel et schéma publiés : commit `cfedca6` sur `main`, workflow
  Supabase `30452933329` réussi le 29 juillet 2026.
- Schéma de production : migrations **01 à 43** appliquées ; les 12 Edge
  Functions sont redéployées.
- **Passe globale du 29 juillet 2026.** La migration 42 corrige deux invariants
  qui étaient annoncés mais pas réellement garantis :
  1. `reserver_alertes()` prend un bail transactionnel avec
     `FOR UPDATE SKIP LOCKED` avant tout Web Push ; deux `dispatch` concurrents
     ne peuvent plus envoyer la même ligne, et les baux abandonnés sont repris
     après cinq minutes ;
  2. la sensibilité appartient à la clé de configuration d'une zone et
     `reconfigurer_zone_abonne()` déplace uniquement le lien du compte. Ajouter
     ou régler une commune ne change plus la sensibilité ou la géométrie d'un
     autre abonné.
  La migration 43 corrige la construction du tableau des raisons de
  `score_association_contexte()` avec `array_append`, sans ambiguïté de
  transtypage PostgreSQL.
  Contrôles externes après déploiement : `/api/sante-publique`, `/api/carte`
  et la PWA répondent HTTP 200 ; la santé est `operationnel` et la carte
  restitue son origine `cache` ainsi que son âge.
  La même passe impose les méthodes HTTP, refuse les jetons dans l'URL, ferme
  les quotas en cas d'erreur, sépare les emprises ultramarines, vérifie la
  résolution DNS et chaque redirection des flux RSS, et répare les actions des
  notifications.
- **Le parcours multi-appareils est complet dans les deux sens.** Trois manques
  se répondaient : on ne voyait pas le bouton d'activation sans compte, on ne
  pouvait pas saisir une clé existante, et on ne pouvait pas détacher un
  appareil une fois rattaché. Un utilisateur pouvait entrer, jamais sortir.
  `#btnDetacher` coupe l'abonnement push de ce navigateur **avant** d'oublier
  la clé — sinon l'appareil continuerait de recevoir les alertes — et laisse
  l'espace et les autres appareils intacts.
- **La clé est montrée à la création du compte.** Elle n'existe que dans le
  stockage local de ce navigateur : vider les données du site, changer de
  téléphone ou de navigateur suffisait à tout perdre sans recours. Le dialogue
  s'ouvre au seul moment où l'utilisateur peut encore la mettre à l'abri.
- **Un appareil vierge peut désormais rejoindre un espace existant.** Deux
  défauts se combinaient sur le cas « second téléphone », le plus important du
  produit puisque les alertes sont par appareil :
  1. `#sectionAlertes` portait `data-prive` et disparaissait donc entièrement
     pour un visiteur sans jeton — y compris le bouton « Activer les
     notifications sur cet appareil », qui est précisément ce qu'on vient y
     faire. Seuls les blocs réellement privés portent maintenant l'attribut ;
     un encart explique la marche à suivre aux autres.
  2. Le dialogue de clé était en **lecture seule** : on pouvait afficher sa
     clé, jamais en saisir une. Il était donc possible de quitter un appareil,
     jamais d'en rejoindre un — un second téléphone ne pouvait que créer un
     compte distinct, sans les zones du premier. Le dialogue accepte
     maintenant une clé, et la vérifie auprès de `/api/etat` **avant** de
     l'enregistrer : une clé fausse laisserait sinon une connexion apparente
     sans aucune alerte derrière.
- La migration 41 corrige un défaut visible dès la mise en production : tous
  les groupes de `/api/carte` avaient `commune: null`. `feux_carte_v29` ne
  consultait jamais la table `communes` — pour un amas satellite, le nom venait
  uniquement d'un groupe citoyen confirmé à proximité. La commune est désormais
  résolue par point-dans-polygone. Deuxième cause : seul le département 31
  était chargé ; la tâche `charger-communes` couvre le pays par lots de trois
  toutes les dix minutes, et s'arrête d'elle-même une fois complète — son état
  est la table `communes`, il n'y a pas de drapeau à gérer.
- **Un contexte non sécurisé est expliqué, plus subi.** Ouvrir `index.html`
  depuis le disque faisait échouer l'activation des notifications sur
  « Script URL's scheme is not 'http' or 'https' », message du navigateur
  incompréhensible pour l'utilisateur. `contexteSecurise()` teste le contexte
  avant toute tentative, affiche `#noteContexte` et renvoie vers la version en
  ligne. Service worker, notifications, installation et cache hors ligne
  exigent tous https ou localhost.
- La référence du projet Supabase vit dans `web/config.js`, plus dans le code
  des trois pages. Ce fichier ne contient aucun secret : l'URL d'un projet est
  publique par nature puisque le navigateur l'appelle.
- La migration 40 ajoute `carte_cache` : six fenêtres de carte pré-calculées,
  rafraîchies toutes les deux minutes par `pg_cron`. `/api/carte` exécutait
  jusqu'ici un `st_clusterdbscan` complet **à chaque appel**, alors que chaque
  client ouvert appelle la route toutes les deux minutes. Le coût était donc
  proportionnel à la fréquentation, au moment précis où elle explose. Il est
  désormais constant. Le cache est ignoré au-delà de six minutes d'âge, et son
  âge est restitué à l'appelant : un cron arrêté ne fige pas la carte.
- Une suite **pgTAP** (`supabase/tests/`) vérifie le moteur et les invariants
  de sécurité après le rejeu des migrations : 77 assertions sur la sévérité,
  le quorum citoyen, le barème de contexte, l'isolation des zones, la
  réservation des alertes, la RLS, les droits et le `search_path` des fonctions
  `SECURITY DEFINER`. Le rejeu des migrations ne contrôlait que la syntaxe.
- **Leaflet et les polices sont servis par le dépôt** (`web/vendor/`). Les
  empreintes SHA-256 des copies correspondent aux attributs d'intégrité qui
  figuraient dans la page. Plus aucune dépendance CDN : une panne d'unpkg ne
  rend plus la carte inaffichable pour un nouveau visiteur, et aucune adresse
  IP ne part vers Google Fonts. Sous-ensemble latin seul, 324 ko.
- `dispatch` dispose d'un **budget de temps** de 50 s : au-delà, il libère les
  réservations restantes et rend la main, sans tentative consommée. Une
  exécution coupée conserve au maximum un bail de cinq minutes, ensuite
  récupérable automatiquement.
- La PWA **avertit quand elle ne peut rien délivrer**. Sans appareil vérifié,
  un encart l'annonce sans détour ; sur iOS non installé, il explique que
  Safari réserve les notifications aux applications ajoutées à l'écran
  d'accueil. E-mail et Telegram ayant été retirés, il n'existe aucun canal de
  rattrapage : un compte iPhone pouvait se croire protégé indéfiniment.
- **État de livraison vérifié le 27 juillet 2026 à 08:14 UTC : migrations 01 à 40
  appliquées, 12 Edge Functions déployées, PWA republiée.** Le dépôt et la
  production sont alignés.

  Contrôles externes effectués après déploiement :
  - `/api/carte` renvoie `"origine":"cache"` avec `age_secondes` de 33 : la
    migration 40 est active et la tâche `rafraichir-carte` tourne ;
  - `/api/sante-publique` répond `ok=true` — collecte polaire à 3 minutes,
    géostationnaire à 13 minutes, `pg_cron` à 13 minutes, 967 détections sur
    24 h et 5 capteurs actifs ;
  - la PWA répond HTTP 200 avec `theme-color:#0b0d10`, le bandeau de cadre,
    la barre de commandes fusionnée et la frise temporelle intégrée.

  Les tests pgTAP se sont donc exécutés pour la première fois : le job
  `deployer` dépend de `verifier`, qui les contient. Leur exécution est
  vérifiable dans l'onglet Actions.
- **Audit du 26 juillet 2026, en soirée** (`docs/COMPTE_RENDU_26072026.md`) : la vague
  fonctionnelle du 26 juillet avait livré des calculs côté client sans le
  support serveur qui les rend exploitables. Trois façades ont été corrigées par
  la migration 39 et la révision de la PWA :
  1. `poll-contexte` ne parsait aucun RSS et n'insérait rien ; il évaluait un
     score sur le nom de la source et 200 octets de XML brut. Il lit désormais
     réellement RSS 2.0 et Atom (`poll-contexte/flux.ts`) et délègue
     l'association à `public.enregistrer_mention_contexte`.
  2. La carte n'exposait aucun `evenement_id`, alors que `/api/contexte` filtre
     `evenement_mentions.evenement_id` : la rubrique de contexte ne pouvait
     jamais rien afficher. `feux_carte` restitue maintenant l'identifiant de
     l'évènement rattaché.
  3. La « vélocité du front » affichée en km/h déduisait une distance parcourue
     de la puissance thermique via un coefficient arbitraire. Elle est
     remplacée par `persistanceFeu()` : durée d'activité et cadence
     d'observation, deux grandeurs réellement mesurées.
- La pente topographique IGN est calculée sur les **quatre orientations
  cardinales** en une requête, et la plus forte est retenue avec son
  orientation. La version précédente ne comparait qu'un voisin au nord-est : un
  versant sud-ouest ressortait faussement plat. Sans réponse de l'IGN, la PWA
  affiche « non disponible » et n'invente aucune valeur de repli.
- La **triangulation optique a été retirée** de la PWA. Le signalement
  enregistre l'emplacement du feu pointé au viseur, jamais la position du
  témoin : un cap boussole n'a donc aucune origine géométrique et deux visées
  sans point de départ ne s'intersectent pas. La colonne
  `signalements.azimut_deg` et sa validation côté serveur restent en place pour
  un futur parcours « je vois le feu depuis ici », qui devra enregistrer la
  position de l'observateur. Tant que ce parcours n'existe pas, rien n'écrit
  cette colonne.
- La PWA suit la **charte 1A tactique sombre**, copiée dans
  [`docs/CHARTE_GRAPHIQUE.md`](CHARTE_GRAPHIQUE.md) : typographies Inter et
  Outfit, palette carbone `#0b0d10`, marqueurs en pastille
  (`.marqueur-feu-tactique`) avec flamme, nom de commune et badge d'état.
  La feuille de style a été réécrite d'un bloc le 26 juillet au soir : la
  refonte précédente avait changé les variables sans reprendre les valeurs
  codées en dur, laissant une quinzaine de restes de l'ancienne palette chaude
  (`#2e2a27`, `#252220`, `rgba(18,16,14,…)`, toast crème, bandeau hors ligne
  brun) et deux `:root` concurrents. Quatre défauts structurels ont été
  corrigés en même temps :
  1. les règles de `.legende-interactive-barre` étaient enfermées dans la media
     query `max-width:560px` : la barre de légende n'avait aucun style au-delà ;
  2. huit classes utilisées par le HTML ou le JS n'avaient aucune règle
     (`badge-compteur`, `cluster-bulle`, `liste-actu`, `meta`,
     `popup-actualites-feu`, `popup-feu-glass`, `viseur-etiquette`,
     `hors-ligne`) : compteurs, bulles de regroupement et info-bulles
     s'affichaient sans habillage ;
  3. le bouton de repli de la légende pilotait un état qu'aucune règle ne
     traduisait, donc il ne faisait rien ; la légende est désormais réellement
     repliable et ouverte par défaut ;
  4. la légende et les marqueurs employaient des teintes différentes pour la
     même sévérité. `COULEUR_NIVEAU` est la table unique, alignée sur la charte.
- Le filtrage par la légende **agit réellement sur les cinq niveaux**. Il ne
  couvrait que « corroboré » et « probable » : cliquer « indices isolés » ou
  « témoins » remettait le filtre à `tous` tout en annonçant l'inverse à
  l'utilisateur. Chaque ligne masque maintenant son niveau, l'état est exposé
  par `aria-pressed` et l'opacité, et le message reflète l'état réel.
- La fraîcheur de la carte est affichée en surimpression
  (`majFraicheurCarte`). La PWA consomme réellement `origine` et
  `age_secondes` : le voyant passe en avertissement dès que la vue provient du
  cache.
- Le vent de la fiche incident reste une mesure météorologique : vitesse,
  secteur d'origine et direction vers laquelle souffle l'air. Il n'est plus
  présenté comme un sens de propagation du feu, qu'aucune source ne mesure.
- La console de modération suit la même charte : elle n'est pas un outil de
  seconde classe, et un écart de palette suffit à faire douter de ce qu'on y lit.
- **Densité et rythme.** L'espacement suit une échelle de 4 px
  (`--e1`…`--e7`) : le fichier comptait 22 valeurs distinctes entre 2 et 20 px.
  Le markup ne pose plus de marges à la main — 62 attributs `style` sont
  devenus 5, tous réellement dynamiques. Trois bandes ont disparu autour de la
  carte : la barre de légende dupliquait la légende flottante à l'identique,
  compteurs compris, et la frise temporelle a rejoint la barre de commandes.
  Au-delà de 1200 px, le panneau latéral suit le défilement. Deux tests
  gardent ces invariants : aucune valeur d'espacement hors échelle, aucun
  style en ligne statique.
- **Visibilité et fonctionnement de la carte, revus le 27 juillet.** Les trois
  surcouches — cadre et fraîcheur, viseur de ciblage, voile de chargement —
  étaient ancrées sur `.carte-carte`, qui contient aussi la recherche, les
  commandes, les filtres et la liste. Conséquences : le cadre s'affichait
  au-dessus de la barre de recherche, le viseur se centrait sur la fiche
  entière au lieu du centre de la carte, et le voile masquait les commandes.
  Un conteneur `.zone-carte` sert désormais de référentiel, et le dégradé bas
  suit la carte. Trois autres corrections :
  1. zoom et sélecteur de fond passent en haut à droite, la légende en bas à
     gauche : ils se superposaient au libellé de cadre et à l'attribution ;
  2. le voile de chargement passe au-dessus des contrôles Leaflet (z-index
     900 contre 800), sans quoi ils transparaissaient pendant le chargement ;
  3. les compteurs de légende restaient à zéro jusqu'à la première interaction
     avec la carte : ils vivent dans un contrôle créé par `initCarte`, appelé
     après le premier rendu du résumé. Les deux parcours rappellent
     `rendreResumeCarte()` après initialisation.
  Le contour des zones surveillées utilisait encore `#e0453c`, hérité de
  l'ancienne palette.
- **La publication de la PWA est désormais subordonnée aux tests.** Le workflow
  « Publier la PWA » ne se déclenchait que sur `web/**` et n'exécutait aucun
  test, tandis que les tests d'interface vivent dans `supabase/functions/_tests`
  et que le workflow Supabase ne se déclenche que sur `supabase/**`. La refonte
  du 26 juillet a donc cassé deux tests d'interface — libellés de légende et
  bascule satellite — et a été publiée quand même, avant six commits de
  rattrapage sur le même écran. Les deux tests sont corrigés et le job
  `verifier` bloque maintenant l'envoi vers Pages.
- La PWA intègre un slider temporel 24 h avec animation Play/Pause pour rejouer
  la chronologie des détections, la mise en cache hors-ligne des tuiles (IGN, OSM, CARTO)
  dans `web/sw.js` (MAX_TUILES=450), l'affichage du vecteur vent au sol (Open-Meteo API)
  et les notifications push actionnables (`voir`, `confirmer`).
- La migration 38 (`sources_rss_regionales_et_nationales.sql`) peuple le
  catalogue `sources_contexte` avec 14 flux RSS nationaux et régionaux. La
  **migration 39 désactive les 10 flux de presse régionale** (`actif = false`,
  `mode = 'desactive'`) : leur licence déclarée « Presse Régionale » n'est pas
  une licence ouverte, et `ETAPE_ACTUALITES_LOCALES.md` exige une validation
  juridique par source qui n'a pas eu lieu. Restent collectées les quatre
  sources sous licence ouverte — Ministère de l'Intérieur, Météo-France, ONF,
  Copernicus EFFIS — en mode `shadow`.
- La migration 37 enrichit la fonction `feux_carte` avec la restitution explicite
  du champ `rayon_incertitude_m` (2000 m), permettant le tracé des emprises
  spatiales d'incertitude sur la carte Leaflet. La PWA intègre un viseur réticule
  tactique de précision (`viseurSignalement`) pour le ciblage cartographique des départs de feu.
- La migration 28 intitulée `retire_interrupteur_homme_mort` a été retirée :
  elle ne doit pas réapparaître. Le numéro 28 est désormais porté par la
  migration distincte `conformite_moderation_audit`.
- Le pipeline GitHub Actions « Publier la PWA » du commit `48ad8d2` a réussi (Run `30220202069`).
  Contrôle externe effectué le 26 juillet : `https://qevedeveq-art.github.io/Alerte-incendie/`
  répond HTTP 200 et présente l'interface tactique avec la carte corrélée, ses marqueurs glassmorphic
  et ses filtres interactifs de légende.
- Contrôle du 26 juillet : les 38 migrations alors présentes s'appliquent sur
  Supabase production. Le conteneur Postgres est sain, les 12 tâches `pg_cron`
  sont présentes — `poll-contexte` comprise —, toutes les tables publiques ont
  RLS active sans aucune policy publique, et les deux contacts RGPD valent
  `qevedeveq@gmail.com`. La migration 39 n'était pas encore écrite à ce moment.
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
  désormais que les notifications sur appareil.
- Étape **Informations locales associées** : lots 1 et 2 du plan livrés, lot 3
  (affichage public) **verrouillé**.
  - Migration 36 : tables `sources_contexte`, `mentions_contexte`,
    `evenement_mentions`, `contexte_moderation_audit` et purge
    `purger_contexte_local()`.
  - Migration 39 : lecture réelle des flux, barème d'association explicable
    (`score_association_contexte`), enregistrement et rattachement
    (`enregistrer_mention_contexte`), file de modération
    (`moderation_contexte`) et décision auditée (`moderer_mention`).
  - `poll-contexte` collecte toutes les 30 minutes, dédoublonne par empreinte
    (source + URL canonique + titre normalisé) et n'écrit que dans les deux
    tables de contexte.
  - `/api/contexte` reste public et limité à 60 req/min/IP, et ne restitue que
    les associations `decision = 'associe'`. `/api/contexte-moderation` et
    `/api/contexte-moderer` exigent `admin_key` et sont audités.
  - **Porte de publication** : une association ne devient `associe`
    automatiquement que si la source est en `mode = 'actif'`. Les quatre
    sources livrées sont en `shadow` : la file se remplit, rien ne s'affiche.
    Le passage en `actif` est une décision humaine, source par source, après
    validation juridique et mesure de précision sur échantillon.
  - La rubrique « Informations locales associées » de la fiche incident et la
    pop-up de survol restent **masquées** s'il n'y a rien de publié — plutôt
    qu'un message d'absence, qui laisserait croire à une panne ou à un calme
    médiatique alors que rien n'a été validé. Rendu HTML échappé, liens `https`
    uniquement, sans traqueur tiers.
  - La console `web/moderation.html` traite les deux files : signalements
    citoyens et contexte local. Clé administrateur en mémoire de page, motif
    obligatoire, décision auditée.

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
| `poll-contexte` | lecture des flux officiels, association et file de modération | admin ou service role |

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
| Contexte local | `sources_contexte`, `mentions_contexte`, `evenement_mentions`, `contexte_moderation_audit` |
| Exploitation | `runs`, `config`, `quotas`, `audit_admin` |

Le domaine « contexte local » est livré par les migrations 36, 38 et 39. Il
reste strictement séparé : aucune de ses tables n'est lue par le moteur de
détection, et aucune de ses fonctions n'écrit dans `evenements`, `detections`
ou `alertes`. Un test vérifie cette séparation sur le texte de la migration et
du collecteur.

## Planification déclarative

Les migrations 26, 32, 36 et 40 sont la source de vérité des tâches `pg_cron`.
Quatorze tâches au total.

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
| `poll-contexte` | toutes les 30 min | contexte local, sans effet sur les preuves |
| `rafraichir-carte` | toutes les 2 min | pré-calcul des fenêtres de carte nationale |
| `charger-communes` | toutes les 10 min | découpage communal national, par lots, jusqu'à complétude |

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
- La carte utilise l'orthophotographie IGN/Géoplateforme avec superposition
  des noms de localités en français (couche IGN GEOGRAPHICALNAMES.NAMES) et
  propose les plans OpenStreetMap France et sombre en repli. Tous les incidents et signalements sont représentés par des marqueurs flammes SVG haute visibilité aux tailles proportionnelles (18 à 44 px). Au survol de la souris (`mouseover`), une pop-up affiche le contexte local **publié** de l'évènement, et reste vide de cette rubrique s'il n'y en a pas.
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
- Une actualité ou une publication sociale est un **contexte**, jamais une
  preuve : elle ne crée, ne corrobore, n'élève et ne clôt aucun événement ou
  alerte. Son volume et sa popularité n'ont aucun poids.
- Une association de contexte exige un **ancrage géographique** : coordonnée
  dans le rayon d'incertitude majoré de 1 km, commune exacte reconnue, ou
  commune limitrophe reconnue. Le vocabulaire incendie et une heure plausible
  ne suffisent jamais, sinon une dépêche nationale se collerait à tous les feux
  du jour. Le type de source ne donne aucun point.
- Une association n'est publiée automatiquement que si la source est en
  `mode = 'actif'`, non sociale, et que le score atteint 70. Tout le reste part
  en file de modération. Le passage d'une source en `mode = 'actif'` est une
  décision humaine, jamais un effet de bord de migration.
- La PWA n'affiche **aucune grandeur qui ne soit pas mesurée**. Pas de vitesse
  ni de sens de propagation : aucune source disponible ne les observe. Une
  valeur indisponible s'affiche comme indisponible, sans repli inventé.
- Le cap d'observation (`signalements.azimut_deg`) n'a de sens qu'avec la
  position du témoin. Comme le signalement enregistre la position du feu, rien
  ne doit écrire cette colonne avant qu'un parcours dédié n'existe.
- Aucun contenu tiers n'est aspiré sans API, flux, webhook ou accord documenté.
  Le système ne réhéberge ni article, ni image, ni vidéo et synchronise les
  suppressions à la source.
- Tout futur contenu social passe d'abord en mode fantôme puis en modération.
  L'application n'affiche ni auteur particulier, ni texte social brut, ni
  information tactique sur les secours.

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
12. **Contexte local collecté mais non publié.** La chaîne complète est livrée
    (lecture des flux, barème, file de modération, console, route publique),
    mais les quatre sources actives sont en `shadow` : rien n'est visible dans
    l'application. Avant d'ouvrir une source, trois conditions du plan restent
    à remplir : validation juridique écrite pour cette source, précision
    mesurée sur un échantillon d'au moins 90 % d'associations correctes, et
    mise à jour de la politique de confidentialité. Les dix flux de presse
    régionale sont désactivés jusqu'à accord écrit.
13. **Barème d'association non encore mesuré.** Le barème suit le plan, mais sa
    précision réelle n'a pas été évaluée sur un échantillon étiqueté : c'est
    précisément l'objet de la période fantôme. Points de vigilance connus : un
    homonyme de commune dans un autre département, et un communiqué
    préfectoral générique couvrant plusieurs feux du même jour.
14. **Reconnaissance de toponyme sensible aux homonymes.** `toponyme_present`
    exige des frontières de mot, ce qui écarte « Aixe-sur-Vienne » pour
    « Aix », mais ne distingue pas deux communes homonymes de départements
    différents. Le filtre temporel et la commune de l'évènement limitent la
    portée du faux rapprochement sans l'éliminer.

Le plan priorisé de réduction de ces risques et d'intégration de nouvelles
sources est maintenu dans `docs/PLAN_AMELIORATION.md`.

## Matrice de mise à jour

| Changement | Fichiers à revoir |
|---|---|
| comportement utilisateur | `README.md`, `web/index.html`, tests |
| couleur, typographie ou composant visuel | `docs/CHARTE_GRAPHIQUE.md`, `web/index.html`, `web/moderation.html`, tests d'interface |
| grandeur affichée à l'utilisateur | vérifier qu'elle est **mesurée** et non déduite ; sinon ne pas l'afficher |
| source de contexte activée ou publiée | `ETAPE_ACTUALITES_LOCALES.md`, `SECURITE.md`, ce fichier, politique de confidentialité |
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
