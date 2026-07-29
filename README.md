# Alerte Incendie

**→ [qevedeveq-art.github.io/Alerte-incendie](https://qevedeveq-art.github.io/Alerte-incendie/)**

La carte est consultable sans compte. Les notifications exigent une adresse
`https` : elles ne fonctionnent pas depuis un fichier ouvert localement.

Projet de service gratuit destiné au public français : alertes autour de
localisations choisies, carte nationale zoomable et signalements citoyens,
complétés par la détection satellite. Les alertes utilisent les
**notifications sur l'appareil** (Web Push). Les canaux Telegram et e-mail sont
temporairement retirés afin de garder un parcours unique et immédiat.

Architecture cible : Supabase (Paris) + PWA statique. L'état exact des
migrations effectivement livrées est suivi dans `docs/CONTEXTE.md`.
Le moteur sait déjà surveiller une commune, ses communes limitrophes et une
marge réglable. La première zone est **Cornebarrieu (31150)** — 287,8 km².
La carte agrège désormais les indices récents sur la France métropolitaine et
la Corse. Elle permet de filtrer chaque famille de source et affiche un score
de corroboration explicable. Le passage à l'échelle, l'outre-mer automatique et
l'ouverture anonyme complète restent suivis dans
[`docs/PLAN_AMELIORATION.md`](docs/PLAN_AMELIORATION.md).

Les **informations locales associées** sont collectées et évaluées, mais **pas
encore publiées**. Un collecteur lit les flux officiels sous licence ouverte
toutes les 30 minutes, rapproche chaque publication des feux actifs selon un
barème explicable, et dépose le résultat dans une file de modération. Rien
n'apparaît dans l'application avant une validation humaine motivée, source par
source. Ces éléments resteront du contexte sourcé : ils ne créent pas de feu,
ne modifient pas sa sévérité et ne déclenchent aucune alerte. Les flux de presse
régionale sont désactivés jusqu'à validation juridique par source — un flux RSS
n'autorise pas la reprise de titres de presse payante. Le séquencement, les
sources et les garde-fous RGPD sont détaillés dans
[`docs/ETAPE_ACTUALITES_LOCALES.md`](docs/ETAPE_ACTUALITES_LOCALES.md).

L'interface est organisée autour de la carte : plein écran utile, regroupement
des marqueurs aux faibles zooms, liste synchronisée, filtres 1/6/24 h et par
niveau de confiance, recherche par commune ou code postal, résumé automatique
autour du lieu choisi, fiche incident partageable et navigation mobile. La
carte reste consultable sans compte ; un compte vérifié n'est demandé que pour
créer une alerte ou contribuer. Le parcours recommandé surveille en un geste la
commune choisie, ses voisines et 3 km autour ; les réglages experts restent
disponibles mais repliés.

---

## Ce que fait le système

### Trois niveaux de détection indépendants

| Niveau | Latence | Précision | Nature de la preuve |
|---|---|---|---|
| **Signalement citoyen** | instantanée | très précise | non vérifiée |
| **Géostationnaire** — Meteosat/SEVIRI | ~25 min | 3 km, seuil ~20 MW | automatique |
| **Polaire** — VIIRS et MODIS | 2-3 h | 375 m | automatique |

Leur intérêt est de se corroborer. Un signalement citoyen confirmé déclenche une
alerte `alerte`, étiquetée non vérifiée. Si un satellite détecte ensuite un foyer
au même endroit — ou l'avait déjà détecté — l'évènement passe en `critique` avec
la mention « témoins + satellite ». C'est le niveau de fiabilité le plus élevé du
système, et il ne dépend d'aucune source unique.

### Signalements citoyens

Chacun peut signaler un départ de feu en pointant la carte après avoir créé un
compte gratuit et activé les notifications sur au moins un appareil. Le jeton
seul ne permet pas de contribuer.

- deux signalements à moins de **50 m** et de moins de 6 h sont le même départ
- confirmation dès **2 personnes sur 2 réseaux distincts**, ou **3 personnes**
  quel que soit le réseau
- non confirmés en gris sur la carte, confirmés en violet
- formulaire structuré : nature, heure, intensité perçue, végétation, proximité
  d'habitations et degré de certitude
- suivi privé du statut : en attente, confirmé par quorum, corroboré par capteur,
  rejeté ou expiré
- console opérateur séparée : file agrégée sans identité, clé administrateur
  gardée uniquement en mémoire, motif obligatoire et décision auditée
- contestation possible par d'autres abonnés, avec le même quorum ; un groupe
  rejeté retire sa preuve citoyenne sans supprimer une éventuelle preuve satellite

Le second critère existe parce qu'exiger deux réseaux bloquait deux voisins
partageant une box, et surtout les abonnés mobiles derrière le NAT d'opérateur —
or les deux premiers témoins d'un feu sont probablement voisins. Un abuseur doit
en revanche fabriquer trois comptes et franchir trois fois le quota horaire.

L'inscription exige une acceptation versionnée des informations du service.
Depuis « Mes données », chacun peut exporter son compte et son historique ou
demander leur suppression immédiate.

### Collecte automatique

Toutes les 10 minutes (polaire) et toutes les 15 minutes (géostationnaire), un
travail planifié :

1. récupère les quatre flux « Active Fire » de **NASA FIRMS** couvrant l'Europe ;
2. conserve au minimum la France métropolitaine et la Corse, puis étend
   l'emprise aux éventuelles zones abonnées situées ailleurs ;
3. dédoublonne (empreinte unique par détection) et écarte les **sources thermiques
   permanentes** apprises automatiquement ;
4. agrège les points restants en **évènements** (2 km / 12 h) et calcule une
   sévérité — `info`, `alerte`, `critique` ;
5. met en file puis envoie les alertes sur les appareils de chaque abonné, en
   respectant son seuil et ses heures silencieuses.

La carte des dernières 24 heures regroupe les observations distantes de moins
de **2 km**. Les preuves sont comptées par famille réellement indépendante :
VIIRS et MODIS forment une seule famille polaire ; Meteosat, un groupe de
témoins vérifiés et une corroboration aérienne comptent séparément. Le score
0–99 aide à lire la concordance mais ne constitue ni une confirmation
officielle ni une probabilité scientifique. La vue satellite IGN est affichée
par défaut, avec passage automatique au plan sombre si ses tuiles échouent. Le
plan sombre devient aussi le choix initial quand le navigateur demande
d'économiser les données. Une légende française distingue :

- les indices isolés en jaune, les signaux forts/répétés d'une seule famille en
  orange et les concordances d'au moins deux familles indépendantes en rouge ;
- les déclarations citoyennes vérifiées par une flamme violette ;
- les déclarations encore non vérifiées par un point gris discontinu.

La taille d'une flamme combine le score, la puissance thermique maximale et la
répétition des observations. Elle exprime l'importance de l'indice, jamais la
surface brûlée.

Au faible zoom, plusieurs incidents sont réunis dans une bulle neutre portant
leur nombre afin d'éviter les superpositions. En zoomant, les flammes
réapparaissent individuellement. Chaque fiche donne d'abord la conclusion
lisible, la chronologie, les sources et la distance ; score, puissance et
résolution restent accessibles dans « Détails techniques ». Le marqueur ne
représente jamais un périmètre de feu.

**FeuxDeForet.fr** est proposé comme carte complémentaire. Ses CGU interdisent
l'extraction ou la réutilisation substantielle sans autorisation écrite et
aucune API publique documentée n'a été trouvée au 26 juillet 2026. Ses données
ne sont donc pas aspirées : une fusion ne sera activée qu'après accord et
fourniture d'un flux partenaire documenté.

Un contrôle de santé interne tourne toutes les 15 minutes : si aucune
collecte n'a réussi depuis 45 minutes, **le système prévient qu'il est muet**
plutôt que de laisser croire au calme.

Une veille GitHub Actions extérieure interroge aussi l'état public toutes les
cinq minutes. Elle échoue si le projet est inaccessible, si la collecte polaire
est trop ancienne ou si `pg_cron` ne passe plus. La PWA affiche la fraîcheur de
ces trois contrôles sans exposer de donnée d'abonné.

La PWA actualise automatiquement les données publiques toutes les deux minutes
et au retour au premier plan. Elle conserve au plus les 250 derniers incidents
publics, 450 tuiles cartographiques et les dépendances nécessaires à la carte
afin d'afficher un état daté en mode hors ligne. La géolocalisation « autour de
moi » reste dans le navigateur tant que l'utilisateur ne choisit pas
explicitement d'enregistrer un point de référence.

### Le vent, pour rendre l'alerte actionnable

« Feu à 4 km » ne dit pas s'il vient vers vous. Les alertes portent désormais le
vent relevé au point du feu — secteur, vitesse et direction de l'air, jamais
présentée comme une propagation du feu —
depuis **Open-Meteo**.

La météo sert aussi à **durcir automatiquement la détection** les jours à risque :
air sec, vent fort et forte chaleur font passer une zone d'`equilibre` à
`sensible`. La modulation est volontairement **asymétrique** : elle ne peut que
rendre le système plus sensible, jamais moins. Assouplir un seuil sur la foi d'une
prévision reviendrait à masquer un départ de feu réel.

### Fin d'alerte

Un évènement sans nouvelle détection depuis 3 heures déclenche un message de fin
vers ceux qui avaient reçu l'alerte. Auparavant l'évènement se clôturait en
silence après 18 h : la dernière information reçue par l'abonné restait une alerte
incendie, indéfiniment. Le message précise qu'un foyer résiduel reste invisible
depuis l'espace.

## Limites, à lire avant de s'y fier

| | |
|---|---|
| Latence | **~25 min** (géostationnaire), **2 à 3 h** (polaire) |
| Résolution | 3 km (géostationnaire), **375 m** (VIIRS), 1 km (MODIS) |
| Revisites | 4 à 8 passages par jour selon la latitude |
| Détecte bien | un feu de végétation d'environ **1 ha ou plus** |
| Ne détecte pas | un départ de feu de quelques minutes, un incendie de bâtiment, un feu masqué par les nuages |

**Ce service complète FR-Alert. Il ne le remplace pas, et ne remplace jamais le
18 ou le 112.**

---

## Architecture

```text
NASA FIRMS ──> poll-firms ─────┐
LSA SAF ─────> poll-lsasaf ────┼─> PostGIS ─> traiter_detections()
Citoyens ────> signalement ────┘                    │
OpenSky ─────> poll-adsb ─> corroboration           v
Open-Meteo ──> poll-meteo ─> risque/vent       evenements
                                                   │
                                                   v
                                           file d'alertes
                                                   │
                                                   v
                                                dispatch
                                                   │
                                                   v
                                              Web Push

Flux officiels ──> poll-contexte ──> file de modération ──> contexte affiché
                   (aucun effet sur la sévérité ni sur les alertes)

PWA GitHub Pages ── x-token ──> api / signalement
pg_cron ──> collectes, contexte, santé interne, clôture, purge et autotests
```

### Tables principales

| Table | Rôle |
|---|---|
| `communes` | contours IGN simplifiés à ~56 m, sert au calcul des limitrophes |
| `zones` | commune + limitrophes + marge, géométrie de surveillance précalculée |
| `abonnes`, `canaux`, `zone_abonnes` | destinataires et leurs appareils Web Push |
| `detections` | points chauds bruts, dédoublonnés par empreinte |
| `sources_permanentes` | cellules de 500 m identifiées comme industrielles |
| `signalements`, `signalement_groupes` | signalements citoyens et leur regroupement à 50 m |
| `signalement_contestations` | contestations collectives et quorum de rejet |
| `evenements` | clusters spatio-temporels = un feu, avec son origine |
| `creneaux_traites` | créneaux satellite déjà décodés |
| `meteo` | dernière observation et indice de risque par zone |
| `observations_aero` | positions d'aéronefs de lutte (ADS-B), corroboration seule |
| `sources_contexte`, `mentions_contexte`, `evenement_mentions` | contexte local sourcé, séparé des preuves, avec sa file de modération |
| `alertes` | file d'envoi, idempotente par (évènement, canal, sévérité, type) |
| `runs` | journal d'exécution, base du contrôle de santé |
| `audit_admin` | journal minimal des appels humains avec la clé administrateur |
| `config` | secrets applicatifs (RLS active, service role uniquement) |

### Règles de sévérité — sensibilité « équilibré »

| Niveau | Conditions |
|---|---|
| `critique` | ≥ 3 points chauds, ou FRP ≥ 50 MW, ou 2 sources concordantes, ou dans la commune avec confiance ≥ 50, FRP ≥ 10 MW **et résolution ≤ 1 km** |
| `alerte` | confiance ≥ 50 (nominal ou high) |
| `info` | tout le reste |

La condition de résolution est importante : un pixel géostationnaire couvre
12,7 km² alors que Cornebarrieu en fait 19. « Dans la commune » n'y localise donc
rien, et sans cette condition une seule détection grossière déclenchait un
`critique`. Les signalements citoyens sont comptés séparément des pixels
satellite et n'élèvent jamais seuls la sévérité au-delà d'`alerte`.

Deux autres profils existent : `sensible` (rien ne passe, plus de faux positifs)
et `conservateur` (quasi zéro faux positif, détection un peu plus tardive).

### Filtrage des fausses alertes

Une cellule de ~500 m qui chauffe **5 jours distincts sur 10 jours**, ou
**8 jours sur 30**, est classée source thermique permanente : usine, torchère,
four. Ses détections sont écartées mais restent visibles en gris sur la carte.
Indispensable ici : la zone de Cornebarrieu borde Blagnac et ses installations
industrielles.

---

## Dépôt

```
supabase/migrations/   43 migrations SQL — schéma, moteur, cron et conformité
supabase/functions/    12 Edge Functions Deno + module partagé + tests
supabase/tests/        suites pgTAP — sévérité, quorum, invariants de sécurité
web/vendor/            Leaflet et polices, servis par le dépôt
web/                   PWA autonome, confidentialité, service worker et console de modération
.github/workflows/     publication Pages, vérification et déploiement Supabase, veille externe
docs/                  contexte, exploitation et sécurité
```

Le déploiement est **subordonné aux tests**, des deux côtés : formatage, lint,
typage, tests unitaires et rejeu de toutes les migrations sur une base vierge
s'exécutent avant tout `db push`, et la publication de la PWA exécute les tests
d'interface avant tout envoi vers Pages. Pour lancer la vérification en local :

```bash
cd supabase/functions && deno task verif
```

### Documentation maintenue

| Fichier | Rôle |
|---|---|
| [`docs/CONTEXTE.md`](docs/CONTEXTE.md) | mémoire technique, état de livraison, invariants et risques |
| [`docs/EXPLOITATION.md`](docs/EXPLOITATION.md) | configuration, surveillance et procédures opérateur |
| [`docs/SECURITE.md`](docs/SECURITE.md) | modèle d'accès, anti-abus et prérequis avant ouverture |
| [`docs/ETAPE_ACTUALITES_LOCALES.md`](docs/ETAPE_ACTUALITES_LOCALES.md) | plan de passage vers les actualités locales et réseaux sociaux |
| [`docs/PLAN_AMELIORATION.md`](docs/PLAN_AMELIORATION.md) | feuille de route priorisée et critères de succès |
| [`docs/CHARTE_GRAPHIQUE.md`](docs/CHARTE_GRAPHIQUE.md) | couleurs, typographies, composants et règles d'interface |
| [`AGENTS.md`](AGENTS.md) | règles de maintenance et mise à jour systématique du contexte |

## Installation depuis zéro

```bash
supabase link --project-ref <ref>
supabase db push
supabase functions deploy
```

Puis renseigner `public.config` (voir `docs/EXPLOITATION.md`), charger les
départements voulus et créer une zone :

```sql
select public.upsert_zone('31150', true, 3000, 'equilibre');
```

```bash
curl -X POST "$URL/functions/v1/load-communes" \
  -H "x-admin-key: $ADMIN_KEY" \
  -d '{"departements":["31"]}'      # ou {"france": true}
```

## Sources de données

- **NASA FIRMS** — points chauds VIIRS S-NPP / NOAA-20 / NOAA-21 (375 m) et
  MODIS C6.1 (1 km), flux régionaux Europe 24 h, sans clé API.
- **LSA SAF / EUMETSAT** — FRP-PIXEL Meteosat SEVIRI, 3 km, cadence 15 min,
  licence CC BY 4.0. Inscription gratuite requise.
- **Open-Meteo** — vent, rafales, humidité et température par zone. Sans clé,
  serveurs en UE, CC BY 4.0.
- **OpenSky Network** — positions ADS-B des aéronefs de lutte, en corroboration
  seule. Désactivé par défaut (`config.adsb`).
- **Sentinel-3 SLSTR FRP NRT** — veille mensuelle du catalogue STAC ; aucune
  ingestion tant qu'un identifiant de collection stable n'est pas exposé et
  évalué en mode fantôme.
- **EFFIS et Météo des forêts** — liens de contexte séparés des observations ;
  ils n'augmentent jamais le nombre de preuves.
- **geo.api.gouv.fr** — découpage communal IGN Admin Express.
- **Les utilisateurs eux-mêmes**, pour les signalements.
- **Flux officiels sous licence ouverte** — Ministère de l'Intérieur,
  Météo-France, ONF, Copernicus EFFIS. Lus toutes les 30 minutes en mode
  fantôme : associés aux feux actifs et déposés en file de modération, jamais
  publiés sans validation humaine.
- **Presse régionale** — catalogue présent mais **désactivé**. La licence
  déclarée n'est pas ouverte : l'existence d'un flux RSS n'autorise pas la
  reprise de titres et de chapôs. Réactivation source par source après accord.
- **Réseaux sociaux** — aucune ingestion. Le pilote restera contextuel, modéré,
  sans auteur ni texte social brut affichés.

### Corroboration aérienne

Un bombardier d'eau qui tourne à basse altitude au-dessus d'un point confirme un
feu réel **et** significatif : ces appareils ne décollent pas pour un feu de
broussaille, et le signal précède souvent le passage polaire suivant.

Deux garde-fous : l'ADS-B ne **crée jamais** un évènement — un appareil en transit
ou en entraînement produirait des faux positifs — et il n'incrémente pas
`nb_detections`, puisque ce n'est pas un pixel chaud. Il ajoute `ADSB` aux sources,
ce qui suffit à déclencher la règle « deux sources concordantes → critique ».

## Licence

MIT pour le code. Les données NASA FIRMS et IGN restent soumises à leurs
licences respectives.
