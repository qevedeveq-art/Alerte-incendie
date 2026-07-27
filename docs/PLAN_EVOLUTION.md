# Plan d'évolution — passe globale du 27 juillet 2026

> **État au 27 juillet, après implémentation.** Les points 2, 3, 5, 7 et une
> partie du 4 sont livrés (migration 40, `supabase/tests/`, budget de temps de
> `dispatch`, dépendances internalisées, avertissement de couverture). Restent
> ouverts : 1 (pousser), 6 (tests des collecteurs), 8 (accessibilité),
> 9 (référence Supabase en dur) et tout le P2. Le détail des livraisons est en
> fin de document.

Revue de l'ensemble du dépôt : base, fonctions Edge, PWA, CI et documentation.
Ce document classe ce qui reste à faire par risque décroissant, avec ce qui a
été réellement mesuré à l'appui. Il complète `PLAN_AMELIORATION.md`, qui garde
la feuille de route produit ; ici, on parle de dette et de robustesse.

## Ce qui est solide

Rappel utile avant la liste des manques, parce qu'elle est longue :

- séparation stricte des familles de preuves, et refus de compter deux fois la
  même famille — c'est le cœur du produit et il est correct ;
- RLS active sans policy publique sur toutes les tables, fonctions révoquées à
  `PUBLIC`/`anon`/`authenticated`, quotas sur chaque route publique ;
- idempotence des alertes, reprise d'envoi avec temporisation, désactivation
  d'un canal après cinq échecs ;
- rétention explicite par table, purge quotidienne, export et suppression du
  compte ;
- déploiement subordonné aux tests des deux côtés, rejeu intégral des
  migrations sur base vierge avant `db push`.

---

## P0 — à traiter avant toute nouvelle fonctionnalité

### 1. ~~Le dépôt et la production ont divergé~~ — résolu le 27 juillet

16 commits poussés, migrations 39 et 40 appliquées, Edge Functions redéployées,
PWA republiée. Vérifié par contrôle externe : `/api/carte` sert désormais depuis
le cache, `/api/sante-publique` répond `ok=true`.

**Découvert au passage — deux limites visibles en production :**

- **Aucun nom de commune sur la carte nationale.** Les groupes renvoyés par
  `/api/carte` ont tous `commune: null` : seul le département 31 est chargé
  dans `communes`. Les pastilles affichent donc « Confirmé » ou « Probable »
  au lieu d'un lieu, ce qui est la première information qu'un lecteur cherche.
  Correctif : `load-communes` avec `{"france": true}`, une seule fois.
- **`evenement_id` est nul hors zone surveillée.** Les évènements ne naissent
  que dans une zone abonnée ; en dehors, la carte n'a rien à rattacher. La
  rubrique de contexte local ne pourra donc jamais s'afficher pour un feu situé
  hors des zones, même une fois une source publiée. À trancher : créer des
  évènements nationaux, ou assumer que le contexte est une fonction de zone.

Constat de terrain au moment du contrôle : un foyer corroboré dans le Var
(43,52 N / 6,04 E), 874 MW, 25 observations sur deux familles indépendantes.
Le système fonctionne.

### 2. La carte nationale recalcule un DBSCAN à chaque requête

`feux_carte_v29` exécute `st_clusterdbscan` sur toutes les détections non
permanentes de la fenêtre demandée, à chaque appel de `/api/carte`. Or la PWA
appelle cette route **toutes les deux minutes par client ouvert**, plus à
chaque retour au premier plan, changement de période et déplacement de carte.

Aujourd'hui le volume est faible et personne ne le sent. Le jour où le service
est utile — canicule, épisode de feux, relais presse — le nombre de clients et
le nombre de détections augmentent **en même temps**. C'est le point de rupture
le plus probable, et il tombera au pire moment.

**Action :** table matérialisée `carte_cache` (une ligne par fenêtre : 1 h, 6 h,
24 h, 72 h), rafraîchie par `pg_cron` toutes les deux minutes, servie
directement par la route. Le quota de 120 req/min/IP devient alors une simple
protection, plus une limite de charge.
**Effort :** une migration et une petite modification de la route.
**Bénéfice :** coût de la route divisé par le nombre de clients.

### 3. Le moteur métier n'a aucun test unitaire

40 tests couvrent l'interface, les analyseurs de flux et les messages. Le cœur
— `traiter_detections`, les règles de sévérité, le dédoublonnage par empreinte,
le quorum citoyen, la promotion en évènement, la corroboration ADS-B — n'est
vérifié que par le rejeu des migrations, qui contrôle la **syntaxe**, pas le
**comportement**.

Autrement dit : une régression qui ferait passer un pixel géostationnaire isolé
en `critique`, ou qui casserait le quorum à deux réseaux, partirait en
production sans qu'aucun test ne s'y oppose. C'est exactement la classe de
défaut qui coûte la confiance des abonnés.

**Action :** pgTAP dans le job Supabase, après `db start`. Premier lot de cas :
- un pixel MSG isolé dans la commune ne dépasse pas `alerte` ;
- trois pixels VIIRS proches produisent un `critique` ;
- deux signalements à 40 m et 5 h sont un seul groupe, à 60 m deux groupes ;
- deux personnes sur deux réseaux confirment, deux sur un seul non, trois oui ;
- une position ADS-B ne crée pas d'évènement et n'incrémente pas `nb_detections` ;
- la météo peut durcir un seuil, jamais l'assouplir ;
- deux appels de `traiter_detections` sur la même détection ne créent qu'une alerte.
**Effort :** une à deux journées. **C'est l'investissement le plus rentable de
cette liste.**

### 4. Sur iPhone sans installation, le service ne prévient personne

Les canaux e-mail et Telegram ont été retirés (migration 35). Il ne reste que
Web Push, qui sur iOS **n'existe que si la PWA est ajoutée à l'écran d'accueil**.
Un utilisateur iPhone qui ouvre le site dans Safari, crée un compte et croit
être protégé ne recevra jamais rien. Il existe bien une note `#noteIos`, mais
c'est une note : elle n'empêche pas de croire l'inverse.

**Action :** rendre l'étape d'installation bloquante dans le parcours d'alerte
sur iOS — le bouton « Activer les notifications » explique et guide au lieu
d'échouer — et exposer dans « Mes alertes » un état franc : « aucun appareil
vérifié, vous ne recevrez aucune alerte ».
**Effort :** une demi-journée. **Impact :** évite la promesse non tenue, qui
est le pire défaut possible pour ce produit.

---

## P1 — qualité de service

### 5. Le rythme d'envoi n'a pas été mesuré

`dispatch` envoie par vagues de 8 requêtes Web Push concurrentes, toutes les
deux minutes. Pour un évènement touchant 1 000 appareils, cela fait 125 vagues
séquentielles. À 200 ms par appel, environ 25 secondes : tenable, mais personne
ne l'a vérifié, et la marge avant le délai maximal d'une fonction Edge est
inconnue.

**Action :** un banc de charge avec des points d'accès factices, puis un budget
de temps explicite dans `dispatch` — au-delà, on rend la main et la file reprend
au passage suivant plutôt que d'être coupée en plein envoi.

### 6. Six fonctions Edge sans aucun test

`poll-lsasaf` (décodeur HDF5, le plus complexe du dépôt), `poll-meteo`,
`poll-adsb`, `load-communes`, `probe-mtg`, `probe-sentinel3`.

**Action :** au minimum des tests sur les fonctions pures de décodage et de
transformation, comme il en existe déjà pour `poll-firms` et `poll-contexte`.
Priorité à `poll-lsasaf` : c'est la source la plus rapide, donc celle dont une
panne silencieuse coûte le plus cher.

### 7. La carte dépend de deux CDN tiers

Leaflet est chargé depuis `unpkg.com`, les polices depuis
`fonts.googleapis.com`. Le contrôle d'intégrité est bien présent sur Leaflet,
mais l'intégrité ne protège pas de l'indisponibilité : **si unpkg tombe, la
carte ne s'affiche pas**. Le service worker met les dépendances en cache, ce qui
sauve les visiteurs déjà venus, pas les nouveaux.

S'y ajoute un point RGPD : Google Fonts fait partir l'adresse IP du visiteur
vers un tiers hors UE, dès la première visite, sans consentement.

**Action :** héberger Leaflet et les deux polices dans `web/`. Le dépôt
devient autonome, le service worker n'a plus de dépendance externe, et la
question du transfert hors UE disparaît.
**Effort :** deux heures. **Bénéfice :** disponibilité et conformité.

### 8. Accessibilité à reprendre

Mesuré sur le HTML : 10 champs sans étiquette programmatique, 3 boutons sans
nom accessible. Le reste est correct — `lang="fr"`, régions `aria-live`,
dialogues natifs, focus visible, `prefers-reduced-motion` respecté.

**Action :** audit WCAG 2.1 AA complet, puis correction. Un service public
d'alerte doit être utilisable au lecteur d'écran, et l'obligation légale
d'accessibilité s'appliquera dès l'ouverture large.

### 9. La référence du projet Supabase est en dur dans la PWA

`web/index.html` et `web/moderation.html` portent l'URL du projet. Un
changement de projet, ou un environnement de recette, impose une modification
du code. **Action :** un petit fichier `config.js` non versionné ou une
substitution à la publication.

---

## P2 — produit, une fois les fondations tenues

### 10. Ouvrir la première source de contexte

Tout est livré et verrouillé. Il reste à étiqueter un échantillon
d'associations réelles, mesurer la précision, obtenir l'accord écrit par
source, mettre à jour la politique de confidentialité, puis basculer une source
en `mode = 'actif'`. Voir `ETAPE_ACTUALITES_LOCALES.md`.

### 11. Parcours « je vois le feu depuis ici »

Le signalement enregistre la position du feu pointé. Un second mode, où
l'utilisateur enregistre **sa** position et sa visée, rendrait la triangulation
optique possible et remplirait enfin `signalements.azimut_deg`. Attention : ce
mode change le sens de `signalements.lat/lon`, qui alimente le regroupement à
50 m et la promotion en évènement. Il faut une colonne distincte, pas une
réinterprétation de l'existante.

### 12. Outre-mer

La collecte couvre la métropole et la Corse, plus l'enveloppe des zones
abonnées. Les territoires ultramarins ne sont pas couverts automatiquement : les
flux FIRMS régionaux à interroger diffèrent, et les fuseaux horaires changent le
raisonnement sur la fraîcheur.

### 13. Sources supplémentaires

MTG FRP-Pixel quand le statut sortira de « demonstration », Sentinel-3 si une
collection stable apparaît, FeuxDeForet.fr sous accord écrit. Aucune de ces
trois n'est bloquante ; toutes sont suivies par des sondes mensuelles.

---

## Ce que je ne recommande pas

- **Un cadre applicatif côté PWA.** 132 ko de HTML autonome, sans étape de
  construction, c'est un atout pour un service qui doit survivre à son auteur.
  Une réécriture en composants coûterait des semaines et n'apporterait aucune
  fiabilité.
- **Ajouter des sources de détection avant d'avoir les tests du moteur.** Chaque
  source nouvelle multiplie les combinaisons de sévérité à vérifier.
- **Ouvrir largement le service avant les points 1 à 4.** L'identité légale du
  responsable et la charge n'ont pas été validées, et une promesse d'alerte non
  tenue se paie une seule fois.

---

## Ordre suggéré

| Ordre | Sujet | Effort | Pourquoi maintenant |
|---|---|---|---|
| 1 | Pousser et déployer | minutes | tout le reste en dépend |
| 2 | Tests pgTAP du moteur | 1–2 j | protège le cœur métier |
| 3 | Cache de la carte | 0,5 j | seul point de rupture identifié à la montée en charge |
| 4 | Parcours iOS honnête | 0,5 j | évite une promesse non tenue |
| 5 | Auto-héberger Leaflet et les polices | 2 h | disponibilité et RGPD |
| 6 | Tests des collecteurs restants | 1 j | `poll-lsasaf` d'abord |
| 7 | Banc de charge `dispatch` | 0,5 j | avant toute communication large |
| 8 | Audit d'accessibilité | 1 j | obligation à l'ouverture |

---

## Livré le 27 juillet 2026

### Cache de la carte nationale — migration 40

`carte_cache` garde six fenêtres pré-calculées (1, 6, 12, 24, 48 et 72 h),
rafraîchies toutes les deux minutes par `pg_cron`. Le coût de `/api/carte`
devient constant au lieu de croître avec la fréquentation.

Deux garde-fous, parce qu'un cache sur un service d'alerte peut mentir plus
longtemps qu'une panne : au-delà de six minutes le cache est ignoré et la carte
recalculée en direct, et l'âge est restitué à l'appelant. La PWA affiche
désormais la date de **calcul** renvoyée par le serveur, plus la date de son
propre téléchargement — « actualisé à l'instant » pour une donnée de cinq
minutes aurait été faux.

Les valeurs intermédiaires du curseur temporel restent calculées en direct :
elles viennent d'une action délibérée, pas d'un rafraîchissement automatique.

### Tests pgTAP du moteur — `supabase/tests/`

51 assertions branchées dans le workflow Supabase, après le rejeu des
migrations :

- **Sévérité** (22) : la règle de résolution, les seuils de FRP, les familles
  concordantes, les trois profils, et une propriété générale — `sensible` n'est
  jamais plus indulgent que `conservateur`, vérifiée sur 1 200 combinaisons.
- **Quorum et contexte** (21) : la table de vérité du quorum citoyen, la
  reconnaissance de toponyme avec frontières de mot (« Aix » n'est pas reconnu
  dans « Aixe »), et le barème d'association point par point.
- **Invariants de sécurité** (8) : RLS active sur toutes les tables, aucune
  policy, aucun droit pour `anon` ou `authenticated`, `search_path` figé sur
  toute fonction `SECURITY DEFINER`. Ces règles étaient énoncées dans
  `SECURITE.md` et vérifiées à la main.

pgTAP est chargé dans la transaction de test et retiré par le `ROLLBACK` : la
base de production n'en porte pas la trace.

### Dépendances internalisées

Leaflet et les polices sont servis par le dépôt. Les empreintes SHA-256 des
copies vendorisées correspondent exactement aux attributs d'intégrité qui
figuraient dans la page : ce sont les mêmes octets que ceux chargés en
production aujourd'hui.

Seul le sous-ensemble latin des polices est conservé — il couvre l'intégralité
du français, toponymes accentués compris. 324 ko au lieu de 728.

Effet : une panne d'unpkg ne rend plus la carte inaffichable pour un nouveau
visiteur, et plus aucune adresse IP ne part vers Google dès la première visite.

### Budget de temps dans `dispatch`

Au-delà de 50 secondes, la fonction rend la main : les alertes non traitées
restent « en_attente », sans tentative consommée, et repartent au passage
suivant deux minutes plus tard. Mieux vaut deux exécutions complètes qu'une
exécution coupée au milieu d'une vague. Le nombre d'alertes reportées est
journalisé dans `runs`.

### Le service ne promet plus ce qu'il ne peut pas délivrer

Un encart apparaît tant qu'aucun appareil n'est vérifié : « Vous ne recevrez
aucune alerte ». Sur iOS non installé, il explique que Safari ne délivre les
notifications qu'à une application ajoutée à l'écran d'accueil, et le clic sur
« Activer » nomme la cause réelle au lieu d'accuser le navigateur.

C'était le défaut le plus grave de la liste : un utilisateur iPhone pouvait
créer un compte, choisir sa commune, et croire être protégé sans que rien ne
lui parvienne jamais.
