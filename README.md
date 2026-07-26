# Alerte Incendie

Surveillance satellite des feux de végétation sur une commune française, ses
communes limitrophes et une marge réglable, avec alertes par **notification
push**, **Telegram** et **e-mail**.

Déployé et opérationnel : Supabase (Paris) + PWA statique.
Première zone surveillée : **Cornebarrieu (31150)** — 287,8 km².

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

Chacun peut signaler un départ de feu en pointant la carte. Un compte gratuit et
instantané suffit — ni e-mail ni mot de passe.

- deux signalements à moins de **50 m** et de moins de 6 h sont le même départ
- confirmation dès **2 personnes sur 2 réseaux distincts**, ou **3 personnes**
  quel que soit le réseau
- non confirmés en gris sur la carte, confirmés en orange

Le second critère existe parce qu'exiger deux réseaux bloquait deux voisins
partageant une box, et surtout les abonnés mobiles derrière le NAT d'opérateur —
or les deux premiers témoins d'un feu sont probablement voisins. Un abuseur doit
en revanche fabriquer trois comptes et franchir trois fois le quota horaire.

### Collecte automatique

Toutes les 10 minutes (polaire) et toutes les 15 minutes (géostationnaire), un
travail planifié :

1. récupère les quatre flux « Active Fire » de **NASA FIRMS** couvrant l'Europe ;
2. ne conserve que les points chauds tombant dans l'emprise des zones surveillées ;
3. dédoublonne (empreinte unique par détection) et écarte les **sources thermiques
   permanentes** apprises automatiquement ;
4. agrège les points restants en **évènements** (2 km / 12 h) et calcule une
   sévérité — `info`, `alerte`, `critique` ;
5. met en file puis envoie les alertes sur les canaux de chaque abonné, en
   respectant son seuil et ses heures silencieuses.

Un contrôle de santé indépendant tourne toutes les 15 minutes : si aucune
collecte n'a réussi depuis 45 minutes, **le système prévient qu'il est muet**
plutôt que de laisser croire au calme.

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

```
NASA FIRMS (4 flux CSV Europe, sans clé API)
        │
        ▼
┌──────────────────────── Supabase — région eu-west-3 (Paris) ────────────────────────┐
│                                                                                     │
│  pg_cron ──10 min──> poll-firms ──> PostGIS ──> traiter_detections()                │
│         └──15 min──> verifier_sante()              │                                │
│         └──2 min───> dispatch <────── file d'alertes                                │
│                          │                                                          │
│                          ├─> Web Push (VAPID, aes128gcm)                            │
│                          ├─> Telegram Bot API                                       │
│                          └─> SMTP                                                   │
│                                                                                     │
│  api  <── jeton d'abonné (x-token) ── PWA                                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
        ▲
   PWA statique (GitHub Pages) : carte Leaflet, réglages, historique
```

### Tables principales

| Table | Rôle |
|---|---|
| `communes` | contours IGN simplifiés à ~56 m, sert au calcul des limitrophes |
| `zones` | commune + limitrophes + marge, géométrie de surveillance précalculée |
| `abonnes`, `canaux`, `zone_abonnes` | destinataires et leurs canaux |
| `detections` | points chauds bruts, dédoublonnés par empreinte |
| `sources_permanentes` | cellules de 500 m identifiées comme industrielles |
| `signalements`, `signalement_groupes` | signalements citoyens et leur regroupement à 50 m |
| `evenements` | clusters spatio-temporels = un feu, avec son origine |
| `creneaux_traites` | créneaux satellite déjà décodés |
| `alertes` | file d'envoi, idempotente par (évènement, canal, sévérité) |
| `runs` | journal d'exécution, base du contrôle de santé |
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
supabase/migrations/   10 migrations SQL — schéma, moteur, cron
supabase/functions/    7 Edge Functions Deno + module partagé
web/                   PWA autonome (1 fichier HTML, service worker, manifeste)
.github/workflows/     publication Pages + déploiement Supabase
docs/                  exploitation et configuration
```

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
- **geo.api.gouv.fr** — découpage communal IGN Admin Express.
- **Les utilisateurs eux-mêmes**, pour les signalements.

## Licence

MIT pour le code. Les données NASA FIRMS et IGN restent soumises à leurs
licences respectives.
