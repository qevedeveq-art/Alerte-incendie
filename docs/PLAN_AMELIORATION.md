# Plan d'amélioration vers un service national gratuit

Revue du **26 juillet 2026**. L'objectif produit est un service gratuit et
accessible au public français, avec :

1. des alertes autour d'une ou plusieurs localisations choisies ;
2. une carte nationale zoomable des événements ;
3. une partie déclarative permettant de signaler et corroborer un départ.

Ce document distingue l'existant vérifié de la cible. Il ne vaut ni validation
opérationnelle par les secours, ni avis juridique.

## Diagnostic actuel

### Fonctionnel

- L'inscription consentie, les zones surveillées, les canaux Push/Telegram/
  e-mail, l'historique, l'export et l'effacement existent dans la PWA.
- Les signalements, leur regroupement, leur confirmation et leur contestation
  collective existent.
- La carte s'initialise sur la France, permet le zoom et agrège désormais les
  détections automatiques métropole/Corse et les groupes citoyens confirmés.
  Des filtres expliquent les quatre familles indépendantes. L'accès anonyme
  complet, l'outre-mer homogène et les tests de charge restent à livrer.
- L'interface mélange aujourd'hui santé globale des collecteurs et couverture
  personnelle : « actif » peut être affiché alors qu'aucune zone n'est créée.
- Le contact public est `qevedeveq@gmail.com`. Une adresse e-mail ne remplace
  toutefois pas le nom ou la raison sociale et l'adresse légale de l'exploitant.

### Livraison et fiabilité

- Le dernier état connu de production s'arrête à la migration 22 ; les
  migrations 23 à 28 ne sont pas encore attestées en production.
- Le dernier workflow Supabase a bien démarré Docker, mais le rejeu s'est arrêté
  dans la migration 26 sur une expression SQL désormais corrigée localement.
  Le workflow PWA est aussi bloqué tant que GitHub Pages n'est pas activé avec
  GitHub Actions comme source.
- Le contrôle interne détecte une collecte muette et la perte de Meteosat, mais
  pas l'arrêt de `pg_cron`, la pause du projet ou une panne Supabase complète.
- Le passage à l'échelle nationale (requêtes cartographiques, débit public,
  volumes PostGIS et notifications) n'a pas encore de test de charge.

## Nouvelles sources pertinentes

| Source | Apport recommandé | Garde-fou |
|---|---|---|
| [MTG FCI FRP-Pixel (EUMETSAT)](https://user.eumetsat.int/catalogue/EO%3AEUM%3ADAT%3A1156) | Priorité : 1 km, toutes les 10 min, ~20 min typiques | Statut démonstration ; comparer sans alerter avant activation |
| [MTG Active Fire Monitoring](https://user.eumetsat.int/resources/user-guides/fire-management) | Signal qualitatif précoce toutes les 10 min | Ne jamais rendre critique seul ; corroboration obligatoire |
| [Sentinel-3 SLSTR NRT FRP](https://documentation.dataspace.copernicus.eu/APIs/STAC.html) | Second processeur européen, confiance et détection 1 km | Latence polaire ; mesurer le gain réel et dédoublonner |
| [EFFIS](https://forest-fire.emergency.copernicus.eu/downloads-instructions) | Couches WMS de danger, feux actifs et surfaces brûlées pour la carte | Les feux actifs viennent de FIRMS : ne pas compter comme preuve indépendante |
| [Météo des forêts](https://meteofrance.com/comprendre-la-vigilance/meteo-des-forets-informer-sensibiliser-le-public-au-danger-incendie) | Fond départemental de prévention et adaptation de l'interface | Ce n'est ni une détection de feu en cours ni une prévision d'incendie |
| [Pyro-SDIS (data.gouv.fr)](https://www.data.gouv.fr/datasets/pyro-sdis-dataset-dimages-pour-la-detection-de-fumees-de-feux-de-foret) | Jeu d'images ouvert pour évaluer un futur classifieur de fumée | Pas un flux temps réel ; revue humaine et tests de biais requis |
| [FeuxDeForet.fr](https://feuxdeforet.fr/partenariat/) | Signal communautaire complémentaire et diffusion croisée | Intégration uniquement après accord écrit et flux partenaire documenté ; aucun scraping |

MTG FRP est le meilleur gain potentiel immédiat : EUMETSAT le distribue depuis
le 7 mai 2026, avec une cadence de 10 minutes et une résolution de 1 km. EFFIS
est surtout utile pour l'affichage et les périmètres ; ses points actifs
réutilisent MODIS/VIIRS via NASA FIRMS et ne constituent donc pas une troisième
preuve. La Météo des forêts sert à expliquer le danger, jamais à annoncer un
incendie.

## Feuille de route priorisée

### P0 — rendre la livraison prouvable

- Publier la correction locale de la migration 26, activer GitHub Pages avec
  GitHub Actions comme source, configurer les trois secrets Supabase, déployer
  les migrations 23 à 29 puis contrôler la table des migrations.
- Déployer les Edge Functions et la PWA, vérifier les routes de santé,
  d'information publique, d'inscription et de carte.
- Ajouter un test synthétique hors Supabase pour détecter projet en pause,
  `pg_cron` arrêté et endpoint inaccessible. Une exécution gratuite externe
  doit seulement lire un endpoint signé et notifier l'opérateur.
- Publier une page d'état minimale : fraîcheur de chaque source, dernier envoi,
  incident connu, sans exposer les secrets ni les données d'abonnés.

**Critère de sortie :** un déploiement reproductible, un contrôle externe et une
preuve horodatée que migrations, fonctions et PWA servent la même version.

### P1 — livrer les trois parcours nationaux

- Créer un accueil avec deux entrées claires : « Voir la carte » sans compte et
  « Recevoir des alertes » avec consentement.
- Initialiser la carte sur la France métropolitaine et la Corse même sans zone,
  avec zoom, regroupement des points et filtres 24 h / 72 h / 7 jours.
- Ajouter une route publique cartographique bornée par emprise, temps et nombre
  de résultats. Appliquer quota, cache, index spatial et pagination.
- N'afficher précisément que les événements automatiques ou citoyens confirmés.
  Arrondir ou regrouper les déclarations non confirmées pour limiter harcèlement,
  panique et atteinte à la vie privée.
- Séparer visuellement « santé des sources » et « vos zones actives » ; proposer
  rayon, adresse, géolocalisation facultative et aperçu avant abonnement.
- Tester clavier, lecteur d'écran, contrastes, mobile, faible débit et mode PWA.

**Critère de sortie :** consultation nationale anonyme rapide et abonnement
localisé compréhensible, sans fuite de données ni confusion sur la couverture.

### P1 — améliorer la détection

- Adapter `probe-mtg` au canal NRT officiel, écrire un collecteur MTG en mode
  observation et conserver MSG comme repli.
- Exécuter au moins deux semaines de comparaison : fraîcheur, disponibilité,
  doublons, faux positifs, petits feux détectés et coût.
- Intégrer Sentinel-3 SLSTR NRT comme corroboration indépendante seulement après
  mesure de latence et validation des identifiants produit.
- Afficher EFFIS et Météo des forêts en couches informatives séparées des
  preuves. Conserver la provenance de chaque pixel et interdire le double compte
  FIRMS/EFFIS.

**Critère de sortie :** seuils calibrés sur des données françaises, retour
automatique à MSG et aucune hausse non mesurée des faux positifs.

### P2 — renforcer la déclaration citoyenne

- Conserver l'exigence déjà implémentée d'un compte actif avec au moins un canal
  actif et vérifié pour créer ou contester un signalement.
- Remplacer le simple point par un formulaire court : fumée ou flammes,
  intensité perçue, heure, précision de localisation et danger immédiat.
- Mettre en tête l'appel au 18/112 en cas de danger ; rappeler que la déclaration
  dans l'application ne prévient pas les secours.
- Prévoir photo facultative seulement après cadrage : suppression EXIF,
  stockage limité, modération, signalement d'abus et durée de conservation.
- Utiliser Pyro-SDIS pour un prototype hors production ; ne jamais publier ni
  rejeter automatiquement une alerte sur la seule décision d'un modèle.
- Chercher un partenariat SDIS/communes pour confirmer les incidents, avec
  traçabilité de la source officielle.

### P2 — capacité, coût et gouvernance

- Tester des scénarios 1 000, 10 000 puis 100 000 abonnés : carte, crons,
  dispatch, reprise après panne et pics régionaux.
- Partitionner ou archiver les détections, mettre en cache les tuiles et
  introduire une file à pression contrôlée avant que Postgres ne sature.
- Choisir un fournisseur e-mail transactionnel et un domaine SPF/DKIM/DMARC ;
  documenter les limites du palier gratuit et le mode dégradé.
- Compléter identité légale, mentions d'hébergement, analyse RGPD, registre,
  procédure d'incident et revue RGAA avant communication nationale.

## Mesures de succès

- fraîcheur médiane et 95e percentile par source ;
- disponibilité externe et retard de `pg_cron` ;
- taux de détections corroborées et faux positifs confirmés ;
- délai détection → notification et taux d'échec par canal ;
- utilisateurs avec au moins une zone active ;
- temps d'affichage de la carte par niveau de zoom ;
- signalements confirmés, contestés et traités ;
- coût mensuel par 1 000 abonnés.

Les alertes doivent toujours indiquer leur source, leur âge, leur précision et
leur statut vérifié ou non. Le service complète l'information officielle et ne
remplace jamais le 18, le 112 ou FR-Alert.
