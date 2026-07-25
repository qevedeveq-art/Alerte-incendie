# Alerte Incendie

Surveillance satellite des feux de végétation sur une commune française, ses
communes limitrophes et une marge réglable, avec alertes par **notification
push**, **Telegram** et **e-mail**.

Déployé et opérationnel : Supabase (Paris) + PWA statique.
Première zone surveillée : **Cornebarrieu (31150)** — 287,8 km².

---

## Ce que fait le système

Toutes les 10 minutes, un travail planifié :

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
| Latence | **2 à 3 h** entre l'observation satellite et la détection |
| Résolution | **375 m** (VIIRS), 1 km (MODIS) |
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
| `evenements` | clusters spatio-temporels = un feu |
| `alertes` | file d'envoi, idempotente par (évènement, canal, sévérité) |
| `runs` | journal d'exécution, base du contrôle de santé |
| `config` | secrets applicatifs (RLS active, service role uniquement) |

### Règles de sévérité — sensibilité « équilibré »

| Niveau | Conditions |
|---|---|
| `critique` | ≥ 3 points chauds, ou FRP ≥ 50 MW, ou 2 capteurs concordants, ou dans la commune avec confiance ≥ 50 et FRP ≥ 10 MW |
| `alerte` | confiance ≥ 50 (nominal ou high) |
| `info` | tout le reste |

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
supabase/functions/    4 Edge Functions Deno + module partagé
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
- **geo.api.gouv.fr** — découpage communal IGN Admin Express.

## Licence

MIT pour le code. Les données NASA FIRMS et IGN restent soumises à leurs
licences respectives.
