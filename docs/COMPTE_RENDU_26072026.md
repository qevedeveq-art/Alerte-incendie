# Compte rendu global et fonctionnel — 26 juillet 2026

Audit du dossier local et du dépôt git à l'état `61eb18a` (arbre propre, aligné
sur `origin/main`).

---

## 1. Ce qu'est l'application aujourd'hui

Service public gratuit d'alerte incendie pour la France métropolitaine et la
Corse. Deux composants seulement :

- **Supabase Paris** — PostGIS + 38 migrations SQL + 12 Edge Functions Deno +
  12 tâches `pg_cron`.
- **PWA statique** — `web/index.html` (2 587 lignes, autonome), service worker,
  console de modération séparée, publiée sur GitHub Pages.

Aucun backend applicatif intermédiaire. La PWA n'appelle que `api` et
`signalement` ; toutes les tables ont RLS active sans policy publique.

### Chaîne fonctionnelle

```
NASA FIRMS  ─> poll-firms   (10 min)  ┐
LSA SAF     ─> poll-lsasaf  (15 min)  ├─> detections ─> traiter_detections()
Citoyens    ─> signalement            ┘                      │
OpenSky     ─> poll-adsb    (5 min)  ─> corroboration seule   ├─> feux_carte()
Open-Meteo  ─> poll-meteo   (:05/:35) ─> durcit la sensibilité v
RSS/contexte─> poll-contexte (30 min) ─> couche séparée   evenements
                                                              │
                                                        file alertes
                                                              v
                                                    dispatch (2 min) ─> Web Push
```

### Fonctionnalités livrées et vérifiées dans le code

| Domaine | État |
|---|---|
| Détection satellite polaire (VIIRS/MODIS) et géostationnaire (SEVIRI) | opérationnel |
| Clustering spatio-temporel 2 km / 12 h en évènements + sévérité info/alerte/critique | opérationnel |
| Filtrage des sources thermiques permanentes (5 j / 10 j ou 8 j / 30 j) | opérationnel |
| Signalements citoyens structurés, quorum 2 réseaux ou 3 personnes, contestation | opérationnel |
| Corroboration aérienne ADS-B (jamais créatrice d'évènement) | opérationnel, désactivé par défaut |
| Alertes Web Push avec vent au point du feu, seuil et heures silencieuses | opérationnel |
| Message de fin d'alerte après 3 h sans détection | opérationnel |
| Carte nationale corrélée, score 0–99, filtres 1/6/24 h et par famille de source | opérationnel |
| Fond IGN satellite + repli OSM France / CARTO + noms de localités FR | opérationnel |
| Slider temporel 24 h avec animation Play/Pause | opérationnel |
| Cache hors-ligne : 250 incidents, 450 tuiles (`sw.js`, `MAX_TUILES=450`) | opérationnel |
| Push actionnables (`voir`, `confirmer`) | opérationnel |
| Console de modération sans identité, clé admin en mémoire, motif obligatoire, audit append-only | opérationnel |
| RGPD : consentement versionné, export et suppression du compte | opérationnel |
| Santé interne 15 min + veille GitHub Actions externe 5 min | opérationnel |
| CI/CD : `deno fmt`/`lint`/`check` + 40 tests unitaires + rejeu complet des migrations avant `db push` | opérationnel |

---

## 2. Ce qui a été modifié récemment

12 commits le 26 juillet entre 20:42 et 23:05, tous côté PWA sauf la
migration 38.

**Vague fonctionnelle (20:42 → 22:39)**

- `poll-contexte` + migration 36 (tables `sources_contexte`,
  `mentions_contexte`, `evenement_mentions`, purge) et route `/api/contexte`.
- Migration 38 : catalogue de 14 flux RSS nationaux et régionaux, `mode=shadow`
  mais `actif=true`.
- Migration 37 : `rayon_incertitude_m` (2 000 m) restitué par `feux_carte`.
- Slider 24 h, cache de tuiles, vecteur vent, push actionnables.
- Pente topographique IGN, cap boussole `azimut_deg`, triangulation optique,
  vélocité du front, matrice de fusion multi-sources.

**Vague cosmétique (22:42 → 23:05)** — 7 commits successifs sur la légende et
les marqueurs : flammes SVG proportionnelles, légende toujours ouverte avec
décomptes et filtrage au clic, harmonisation légende/marqueurs, puis refonte UI
tactique (Inter + Outfit, palette carbone `#0b0d10`, glassmorphism, marqueurs
ovales avec nom de commune et badge d'état).

Le pipeline « Publier la PWA » du commit `48ad8d2` a réussi (run 30220202069) et
le site répond HTTP 200.

---

## 3. Écarts constatés — à traiter

### 3.1 La couche « informations locales » est un tuyau vide (bloquant fonctionnel)

`poll-contexte` télécharge bien chaque flux, mais **ne parse aucun RSS et
n'insère jamais dans `mentions_contexte` ni `evenement_mentions`**. Il calcule un
score sur `s.nom` comme titre et `texte.slice(0, 200)` de XML brut comme résumé,
puis incrémente un compteur. Rien n'est stocké.

Conséquence : la rubrique « Informations locales associées » de la fiche
incident et la pop-up de survol seront **toujours vides**, alors que l'interface
et la migration 38 sont livrées.

Second défaut indépendant : la PWA appelle
`/api/contexte?groupe=${f.id}` où `f.id` vaut `sat-<md5>` ou `cit-<uuid>`
(`feux_carte_v29`), alors que la route filtre `evenement_mentions.evenement_id`,
un uuid d'évènement. La jointure ne pourrait pas matcher même avec des données.

### 3.2 `azimut_deg` n'est jamais persisté

La PWA capte le cap boussole et le place dans le payload de signalement, mais
aucune colonne `azimut` n'existe en base et `enregistrer_signalement` ne le
reçoit pas. La triangulation optique ne peut donc fonctionner qu'entre deux
signalements du même navigateur, dans la même session — soit jamais en pratique.

### 3.3 `calculerVelociteFeu()` produit un chiffre inventé

```js
const distKm = Math.min(15, (Number(f.frp_max) || 5) * 0.08 * (obs > 2 ? 1.4 : 0.8));
const vitesseKmh = distKm / heures;
```

La distance parcourue est déduite de la puissance thermique par un coefficient
arbitraire — ce n'est pas une mesure de déplacement. Afficher une « vélocité du
front en km/h » à un riverain sur cette base est un risque de crédibilité
sérieux sur un service d'alerte. À retirer de l'affichage ou à requalifier
explicitement en ordre de grandeur non mesuré.

### 3.4 `calculerPenteIGN()` mesure une pente arbitraire

La pente est calculée entre le point et un point décalé de `+0.002°` en
latitude **et** longitude, soit un unique azimut nord-est (~280 m). Ce n'est pas
la pente maximale du terrain. Un feu sur un versant orienté sud-ouest donnera
une pente faussement plate.

### 3.5 Documentation désynchronisée

| Affirmation | Réalité |
|---|---|
| `README.md` : « 35 migrations SQL », « 11 Edge Functions » | 38 migrations, 12 fonctions |
| `README.md` : « 150 tuiles cartographiques » | `MAX_TUILES = 450` |
| `README.md` : « Actualités — aucune ingestion actuellement », « pas encore active » | `poll-contexte` déployé, planifié toutes les 30 min, 14 flux `actif=true` |
| `CONTEXTE.md` tableau « Modules Edge » (11 lignes) et tableau `pg_cron` (12 tâches) | `poll-contexte` absent des deux |
| `CONTEXTE.md` : « Le futur domaine contexte local… ne sera ajouté que par une nouvelle migration » | déjà ajouté (36 et 38) |

C'est le point le plus contraire à `AGENTS.md`, qui impose la mise à jour
systématique du contexte.

### 3.6 Question juridique ouverte sur les flux presse

La migration 38 active des flux `Var-Matin`, `Midi Libre`, `Sud Ouest`,
`Corse-Matin`, `L'Indépendant`, `La Marseillaise`, `Le Progrès` sous la licence
déclarée « Presse Régionale » — c'est-à-dire aucune licence ouverte. L'invariant
« aucun contenu tiers aspiré sans accord documenté » est formellement respecté
(un flux RSS existe) mais la réutilisation de titres et chapôs de presse payante
n'est pas couverte par la simple existence du flux.
`ETAPE_ACTUALITES_LOCALES.md` exige une validation juridique par source : elle
n'a pas eu lieu.

### 3.7 Sept commits pour une légende

La séquence 22:42 → 23:05 corrige six fois de suite le même écran. Les tests
`carte_ui.test.ts` vérifient la présence de chaînes dans le HTML, pas le rendu :
ils ne pouvaient pas attraper « des ronds parasites doublent les flammes ». Un
contrôle visuel (capture avant/après) coûterait moins que six allers-retours en
production.

---

## 4. Priorités suggérées

| # | Action | Pourquoi |
|---|---|---|
| 1 | Corriger `README.md` et `CONTEXTE.md` (compteurs, `poll-contexte`, statut réel du contexte) | la mémoire du projet est la seule source de vérité en reprise ; elle est fausse |
| 2 | Retirer ou requalifier l'affichage de la vélocité du front | chiffre inventé présenté comme une mesure, sur un service d'alerte |
| 3 | Décider : soit implémenter réellement le parsing RSS + l'insertion + la clé de jointure, soit masquer la rubrique « Informations locales » | fonctionnalité visible mais structurellement vide |
| 4 | Migration `azimut_deg` sur `signalements`, sinon supprimer la capture boussole | code mort côté client |
| 5 | Corriger la pente (4 azimuts et retenir le max) ou l'étiqueter « pente NE indicative » | valeur trompeuse en montagne |
| 6 | Passer les 14 flux presse à `actif=false` en attendant la validation juridique par source | seul point où le dépôt s'écarte de sa propre politique |
| 7 | Ajouter un contrôle visuel de la carte au workflow PWA | six commits de rattrapage sur un seul écran |

Les points 3, 4 et 5 ont un point commun : la vague de 22:39 a livré des
calculs sophistiqués côté client sans le support serveur ou les données qui les
rendent exploitables. Ce sont des façades, pas des régressions — mais sur un
service d'alerte incendie, une façade qui affiche un nombre est plus dangereuse
qu'une fonctionnalité absente.

---

## 5. Suite donnée — 26 juillet 2026, en soirée

Les sept points ont été traités. Détail dans `CONTEXTE.md`.

| # | Traitement |
|---|---|
| 1 | `README.md`, `CONTEXTE.md`, `EXPLOITATION.md`, `PLAN_AMELIORATION.md` et `ETAPE_ACTUALITES_LOCALES.md` resynchronisés sur l'état réel |
| 2 | Vélocité en km/h retirée, remplacée par la durée d'activité et la cadence d'observation, deux grandeurs mesurées |
| 3 | Contexte local réellement implémenté : lecture RSS 2.0 et Atom, barème du plan en base, file de modération, clé de jointure corrigée, rubrique masquée si rien n'est publié |
| 4 | Migration 39 : colonne `azimut_deg` et validation serveur conservées ; **capture et triangulation retirées de la PWA** — le signalement enregistre la position du feu, pas celle du témoin, donc un cap n'a aucune origine géométrique |
| 5 | Pente calculée sur quatre orientations cardinales en une requête, la plus forte retenue avec son orientation ; « non disponible » sans réponse IGN |
| 6 | Les dix flux de presse régionale passent à `actif = false` ; les quatre sources sous licence ouverte restent en `shadow` |
| 7 | Cause racine trouvée : le workflow « Publier la PWA » ne lançait aucun test, et le workflow Supabase ne se déclenche que sur `supabase/**`. Deux tests d'interface étaient rouges depuis la refonte. Corrigés, et la publication est maintenant bloquée par un job `verifier` |

Vérification : `deno fmt`, `deno lint`, `deno check` et 52 tests unitaires
passent, dont 13 nouveaux sur le lecteur de flux, les invariants de la
migration 39 et les grandeurs affichées. Le rejeu complet des migrations sur
base vierge reste exécuté par la CI, qui a besoin de Docker.
