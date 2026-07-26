# Plan d'amélioration — application nationale précise et vérifiable

Revue du **26 juillet 2026, en soirée**. L'objectif est un service gratuit et accessible
au public français : carte nationale, alertes personnalisées et signalements
citoyens. Ce document distingue l'existant livré des évolutions proposées.

## État réel

- Le dépôt porte 39 migrations et 12 Edge Functions ; la production en a 38 et
  12. La migration 39 attend son `db push`.
- Le contexte local est collecté et évalué, mais **aucune source n'est
  publiée** : la file de modération se remplit, l'application n'affiche rien.
  Voir `ETAPE_ACTUALITES_LOCALES.md` pour les conditions d'ouverture.
- Règle tenue depuis l'audit du 26 juillet au soir : **la PWA n'affiche aucune grandeur
  qui ne soit pas mesurée**. La « vélocité du front » en km/h, déduite de la
  puissance thermique par un coefficient arbitraire, a été retirée ; la
  triangulation optique aussi, faute de position d'observateur.
- La publication de la PWA est désormais bloquée par les tests d'interface, qui
  ne tournaient jusqu'ici sur aucun push `web/**`.
- Les migrations 01 à 35, les Edge Functions et la PWA sont en production.
  Le déploiement du commit `ebceaf6` est vérifié par GitHub Actions et par des
  contrôles externes HTTP.
- La carte publique corrèle quatre familles indépendantes : polaire,
  géostationnaire, citoyenne et aérienne.
- La vue satellite IGN/Géoplateforme est le fond par défaut. Une légende
  française sépare flammes automatiques, flammes citoyennes vérifiées et points
  gris non vérifiés. La taille 1–3 exprime l'importance de l'indice, pas une
  surface brûlée.
- Un compte actif avec les notifications Web Push activées sur au moins un
  appareil est obligatoire pour créer ou contester un signalement.
- La veille GitHub extérieure contrôle désormais Supabase et `pg_cron` toutes
  les cinq minutes. Elle reste dépendante de GitHub et de ses notifications.
- L'outre-mer homogène, la charge nationale et l'identité légale complète de
  l'exploitant ne sont pas encore validés.
- Livraison du commit de production `ebceaf6` : interface
  carte-first, clustering, filtres temps/confiance, liste et fiche incident,
  parcours d'alerte guidé, navigation mobile, installation/hors-ligne,
  recherche commune/code postal, résumé automatique, réglage recommandé,
  formulaires sans invites système, accessibilité renforcée et console de
  modération auditée. Les migrations 34 et 35 sont publiées ; la seconde
  simplifie les alertes aux notifications sur appareil uniquement.

### Avancement du plan prioritaire

Réalisé, déployé et vérifié le 26 juillet :

- classification rouge/orange/jaune corrigée par familles indépendantes ;
- fiche de preuve avec sources, fraîcheur, résolution et limites de précision ;
- état public et veille GitHub extérieure toutes les cinq minutes ;
- formulaire citoyen structuré, historique privé et journal de modération ;
- cache borné des dernières tuiles IGN pour consultation dégradée hors ligne ;
- sonde mensuelle Sentinel-3 et recommandation MTG corrigée pour éviter tout
  double compte géostationnaire ;
- correction de la corroboration ADS-B, qui ne pouvait pas ajouter sa source
  au tableau SQL dans la version précédente ;
- liens EFFIS et Météo des forêts séparés des preuves.

Réalisé et validé localement dans le lot d'interface suivant :

- carte anonyme prioritaire occupant 56 % de la hauteur mobile et jusqu'à
  760 px sur ordinateur ;
- clusters neutres aux faibles zooms, liste triée par distance ou confiance,
  fiche détaillée et lien direct partageable ;
- filtres 1/6/24 h, tous/forts/corroborés et familles de sources ;
- navigation mobile Carte/Alertes/Signaler/Compte et parcours d'activation en
  trois étapes ;
- recherche publique par commune ou code postal, résumé du signal le plus
  proche et ajout direct d'une surveillance recommandée ;
- actualisation toutes les deux minutes, au retour dans l'application et à la
  demande, sans rechargement de page ;
- choix automatique d'un fond léger si l'économie de données est active et
  repli automatique si les tuiles satellite échouent ;
- dialogues accessibles pour la clé privée, la contestation et les
  confirmations destructives ;
- cache borné de 250 incidents publics, état hors ligne et invite
  d'installation ;
- console opérateur sans PII, clé en mémoire, motif obligatoire et audit.

Restent dépendants d'un tiers ou d'une campagne d'évaluation :

- mener les comparaisons MTG/Sentinel pendant deux semaines quand leurs flux
  sont effectivement disponibles et stables ;
- obtenir les accords FeuxDeForet.fr, SDIS ou préfectures ;
- qualifier l'outre-mer, la charge nationale, le RGAA et le cadre juridique.

Lot livré :

- **Contexte local sourcé** : Implémentation de la **migration 36** (`sources_contexte`, `mentions_contexte`, `evenement_mentions`, `contexte_moderation_audit`), de la fonction `purger_contexte_local()`, du collecteur shadow `poll-contexte`, de la route `/api/contexte` et de la rubrique PWA dans la fiche incident.
- Le contenu contextuel reste strictement séparé et ne modifie jamais la détection, la sévérité ou les alertes.

Le plan d'exécution complet, les sources, le barème d'association et les portes
de production sont dans
[`ETAPE_ACTUALITES_LOCALES.md`](ETAPE_ACTUALITES_LOCALES.md).

## Ce que FeuxDeForet.fr fait bien

L'audit du site, de sa [carte des feux](https://feuxdeforet.fr/cartes/feux/),
de son [espace chercheurs et données](https://feuxdeforet.fr/data/) et de sa
[charte de modération](https://feuxdeforet.fr/moderation/) montre :

- une couverture éditoriale large : feux en cours, vigilance journalière,
  historique, prévention, actualités, régions et moyens de lutte ;
- un site et des applications iOS/Android centrés sur la consultation et le
  signalement ;
- des déclarations structurées autour de l'observation, la localisation, la
  description et éventuellement une photo récente sans visage ni plaque ;
- deux voies de validation annoncées : analyse automatique, ou communauté avec
  validation possible par l'équipe de modération ;
- un cadre utile contre les faux contenus, les données personnelles et les
  informations opérationnelles sur les secours.

Leur charte autorise toutefois les messages de visiteurs enregistrés ou non,
ne publie pas les seuils de l'analyse automatique et prévoit qu'un refus puisse
rester sans notification. Leur page « chercheurs et data » est rendue
dynamiquement sans documentation d'API publique visible. Ces constats ne
prouvent pas une faiblesse de leur moteur ; ils indiquent les endroits où notre
service peut offrir davantage de transparence.

Les CGU de FeuxDeForet.fr interdisent l'extraction ou la réutilisation
substantielle sans autorisation écrite. Aucun scraping ni recopie de marqueurs
ne doit être ajouté. Une intégration exige un accord partenaire définissant
endpoint, licence, attribution, quotas, cadence, rétention et procédure
d'incident.

## Positionnement distinctif

Ne pas chercher à devenir un portail d'actualité de plus. Le produit doit être
le **compagnon d'alerte personnel fondé sur les preuves** :

1. provenance, âge, résolution et incertitude visibles pour chaque observation ;
2. corrélation indépendante sans double compter VIIRS, MODIS et EFFIS ;
3. alerte autour des lieux choisis, avec fraîcheur et état des sources ;
4. modération traçable, contributions réservées aux comptes vérifiés et droit
   de recours ;
5. aucune donnée tactique sur les secours et aucun statut présenté comme
   confirmation officielle sans source officielle.

## Sources à évaluer

| Source | Gain attendu | Garde-fou |
|---|---|---|
| [MTG FCI FRP-Pixel](https://user.eumetsat.int/catalogue/EO%3AEUM%3ADAT%3A1156) | Environ 1 km et cadence 10 min | Exécuter d'abord en observation, comparer à MSG |
| [Sentinel-3 SLSTR NRT](https://documentation.dataspace.copernicus.eu/APIs/STAC.html) | Deuxième processeur européen | Mesurer la latence et dédoublonner les passages |
| [EFFIS](https://forest-fire.emergency.copernicus.eu/downloads-instructions) | Périmètres, danger et surfaces brûlées | Les feux actifs réutilisent FIRMS : couche informative seulement |
| [Météo des forêts](https://meteofrance.com/comprendre-la-vigilance/meteo-des-forets-informer-sensibiliser-le-public-au-danger-incendie) | Contexte départemental de danger | Ce n'est pas une détection de feu en cours |
| [Pyro-SDIS](https://www.data.gouv.fr/datasets/pyro-sdis-dataset-dimages-pour-la-detection-de-fumees-de-feux-de-foret) | Évaluation hors production d'un classifieur de fumée | Jamais de décision automatique unique |
| FeuxDeForet.fr partenaire | Témoignage complémentaire | Accord écrit, provenance « communautaire », aucun double compte |
| flux officiels locaux et médias autorisés | Contexte fiable et actionnable par incident | Liste blanche, attribution, lien original et aucun effet sur l'alerte |
| GDELT, Bluesky et Mastodon | Découverte rapide d'informations publiques | Mode fantôme, rétention courte et modération du social |

## Feuille de route priorisée

### P0 — contexte local sourcé, mesure de précision

Le mécanisme est livré (migrations 36, 38, 39 et `poll-contexte`). Ce qui reste
n'est plus du code, c'est de la mesure et du droit :

- étiqueter à la main un échantillon d'associations réelles produites par la
  file de modération, et calculer la précision par source ;
- documenter titre par titre l'autorisation de reprise ; les dix flux de presse
  régionale restent désactivés jusque-là ;
- mettre à jour `web/confidentialite.html` avant toute première publication ;
- passer alors la première source en `mode = 'actif'`, et la refermer au moindre
  doute — la coupure est unitaire et immédiate ;
- garder GDELT comme outil de découverte de liens, sans recopier les articles ;
- ne pas ouvrir le pilote social avant que les autorités ne soient stabilisées.

**Sortie :** au moins 90 % d'associations correctes sur le jeu de référence
autorité/média, 100 % des éléments publics attribués et horodatés, retrait en
moins de 6 h, et zéro effet sur `severite`, `score` ou `alertes`.

### P0 — n'afficher que des grandeurs mesurées

Leçon de l'audit du 26 juillet au soir : une façade qui affiche un nombre est plus
dangereuse qu'une fonctionnalité absente. Sur un service d'alerte, un chiffre
plausible mais fabriqué est repris tel quel par la personne qui le lit.

- avant d'ajouter un indicateur, écrire d'où vient chaque terme du calcul ;
- si une source ne mesure pas la grandeur, ne pas l'estimer : soit la mesurer
  autrement, soit ne rien afficher ;
- pas de valeur de repli rassurante quand une source externe ne répond pas ;
- la propagation — vitesse et direction du front — reste hors de portée avec
  les sources actuelles. Elle exigerait des périmètres successifs, pas des
  centres de regroupement à 2 km.

### P0 — disponibilité observable de l'extérieur

- Ajouter un moniteur gratuit hors Supabase qui appelle une sonde signée toutes
  les cinq minutes et vérifie HTTP, version déployée, fraîcheur des collecteurs
  et retard de `pg_cron`.
- Publier une page d'état sans données d'abonnés : dernière observation par
  famille, latence, incident connu et version.
- Déclencher une notification opérateur sur trois échecs consécutifs et tester
  volontairement la pause du cron et l'indisponibilité du projet.

**Sortie :** une panne complète est détectée en moins de 20 minutes par un
système qui ne dépend pas du projet surveillé.

### P1 — fiche d'incident explicable

- Ouvrir au clic une chronologie des observations avec source, heure,
  résolution, FRP, précision et raison du score.
- Afficher l'emprise ou le rayon d'incertitude du pixel au lieu de laisser le
  marqueur suggérer une précision ponctuelle.
- Faire décroître visuellement la confiance avec l'âge ; statuts explicites :
  « observé », « probable », « corroboré », « plus observé », « clos ».
- Ajouter distance aux zones abonnées, vent et évolution, sans donner
  d'instruction d'évacuation non officielle.
- Ajouter filtres 6 h / 24 h / 72 h et regroupement des marqueurs au faible
  zoom ; conserver une forme en plus de la couleur pour l'accessibilité.

**Sortie :** un utilisateur peut expliquer pourquoi un feu apparaît, ce qui
l'a corroboré et quelle est la précision réelle de chaque preuve.

### P1 — détection plus rapide et plus précise

- Adapter `probe-mtg` au flux NRT officiel, puis collecter MTG en mode fantôme
  pendant deux semaines face à MSG et FIRMS.
- Mesurer disponibilité, latence p50/p95, doublons, petits feux utiles, faux
  positifs et coût avant d'autoriser MTG à déclencher une alerte.
- Tester Sentinel-3 selon le même protocole.
- Conserver EFFIS et Météo des forêts comme liens contextuels séparés tant que
  le WMS EFFIS dépasse 30 secondes ; interdire qu'EFFIS augmente le nombre de
  preuves FIRMS.
- Calibrer le score sur des incidents français clôturés et publier les règles
  et versions du modèle.

**Sortie :** gain de latence démontré sans hausse non mesurée des faux positifs,
avec repli automatique sur MSG.

### P1 — modération plus sûre et plus transparente

- Garder l'exigence de compte et d'appareil Web Push actif ; ne pas ouvrir de
  commentaire anonyme ou de fil libre.
- Remplacer les invites par un formulaire structuré : fumée/flammes, intensité
  perçue, heure, végétation, proximité d'habitations et degré de certitude.
- Donner à l'auteur un état et un motif codifié : en attente, regroupé,
  confirmé par quorum, corroboré automatiquement, contesté, expiré ou rejeté.
- Créer une file modérateur avec journal immuable, double regard pour les cas
  sensibles, délai cible et procédure de recours.
- Si les photos sont ajoutées : suppression EXIF, détection de visages et
  plaques, quarantaine avant publication, consentement, rétention courte et
  suppression. Une IA assiste la revue mais ne valide ni ne rejette seule.
- Bloquer les textes contenant positions, mouvements ou stratégies des secours.

La file simple, le motif obligatoire et le journal sont réalisés localement.
Le double regard, le recours formel et les photos restent volontairement hors
activation : une photo exigerait suppression EXIF, détection de visages et
plaques, quarantaine, consentement spécifique et purge de stockage démontrée.

**Sortie :** toute décision est traçable et contestable, sans exposer de donnée
personnelle ou opérationnelle.

### P2 — expérience nationale supérieure

- Alertes multi-zones avec rayon, géolocalisation facultative, résumé de
  confiance, précision, âge et état des sources.
- Mode PWA hors ligne pour consignes de prévention et dernier état connu,
  clairement horodaté comme potentiellement obsolète.
- Pages départementales utiles mais factuelles : danger, restrictions
  officielles sourcées, historique et délais de détection, sans course aux
  actualités.
- Badge réservé aux partenaires SDIS/préfectures vérifiés et flux différé ne
  contenant aucune tactique opérationnelle.
- Couverture outre-mer source par source, tests clavier/lecteur d'écran,
  contrastes, faible débit et charge à 1 000, 10 000 puis 100 000 abonnés.

### P2 — gouvernance et gratuité durable

- Compléter l'identité légale, l'hébergement, le registre RGPD, l'analyse
  d'impact, la procédure d'incident et la revue RGAA.
- Chiffrer stockage, tuiles et notifications Web Push par tranche de 1 000
  abonnés ; documenter les limites gratuites et le mode dégradé.
- Publier méthode de corrélation, changelog du score et statistiques agrégées
  de faux positifs, sans ouvrir les données personnelles.

## Mesures de succès

- disponibilité externe et retard maximal de `pg_cron` ;
- latence p50/p95 par source et détection vers notification ;
- taux de corroboration, faux positifs confirmés et incidents manqués connus ;
- précision et âge affichés pour 100 % des marqueurs ;
- délai médian de modération, taux de recours et décisions révisées ;
- temps d'affichage par zoom, accessibilité et taux d'échec faible débit ;
- coût mensuel par 1 000 abonnés et taux d'abonnés avec une zone active.
- précision des associations d'informations locales par type de source, délai
  de retrait et vérification d'un effet strictement nul sur les alertes.

Le service complète l'information officielle. Il ne remplace jamais le 18, le
112, FR-Alert, les SDIS ou les préfectures.
