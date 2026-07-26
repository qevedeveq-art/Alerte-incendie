# Étape suivante — informations locales associées aux feux

Plan arrêté le **26 juillet 2026**. Cette capacité est **planifiée mais non
active** : aucun article, flux social ou contenu tiers n'est encore collecté,
stocké ou affiché par l'application.

## Objectif

Ajouter à la fiche de chaque feu une rubrique **Informations locales** qui aide
à comprendre la situation :

- communiqués de préfecture, SDIS, commune ou autre autorité identifiée ;
- articles de médias locaux accessibles par un flux ou un accord autorisant la
  réutilisation ;
- publications sociales publiques suffisamment proches dans le temps et dans
  l'espace, après les contrôles prévus ci-dessous ;
- informations partenaires, notamment FeuxDeForet.fr, uniquement avec un accord
  écrit et un flux documenté.

Cette rubrique apporte du contexte. Elle ne remplace ni les preuves thermiques,
ni les signalements vérifiés, ni les informations officielles de sécurité.

## Invariant produit

Une information locale n'est **jamais une nouvelle famille de détection**.

- Elle ne crée pas d'événement.
- Elle ne change ni `score`, ni `severite`, ni `familles_independantes`.
- Elle ne déclenche, n'élève et ne clôt aucune alerte.
- Dix reprises du même message ne comptent pas comme dix confirmations.
- La popularité, le nombre de vues ou de partages n'est pas un indice de
  véracité.
- Le libellé « source officielle » est réservé à un compte ou un flux dont
  l'identité a été vérifiée par l'opérateur.
- Une publication sociale reste étiquetée « publication publique non vérifiée »
  même si son association géographique est forte.

Une future décision permettant à un flux structuré d'un SDIS ou d'une préfecture
de devenir une preuve imposerait une évolution distincte du modèle, une nouvelle
migration, des tests et une revue de sécurité. Elle ne fait pas partie de cette
étape.

## Expérience utilisateur cible

La fiche incident affichera au plus cinq éléments récents, classés par type et
date :

1. **Autorité identifiée** ;
2. **Média local** ;
3. **Publication publique**.

Chaque ligne montre le type de source, le titre ou un résumé factuel très court
si sa reprise est autorisée, l'heure de publication, l'heure de dernière
vérification et un lien vers l'original. Le produit ne réhéberge ni article,
ni image, ni vidéo. Les publications sociales ne sont pas intégrées dans un
`iframe` et ne chargent aucun traqueur tiers dans la PWA.

Les libellés prévus sont :

- « communiqué officiel lié à cet incident » ;
- « article local probablement lié » ;
- « publication publique rapprochée — non vérifiée » ;
- « association à confirmer » dans la console opérateur ;
- « retiré à la source » si une information précédemment affichée disparaît.

Un bouton **Pourquoi ce lien ?** expose les raisons d'association : commune,
distance, écart temporel et mots de contexte. Le score d'association ne sera
jamais affiché comme une probabilité de vérité.

## Sources proposées

### Ordre de priorité

| Priorité | Source | Mode envisagé | Décision |
|---|---|---|---|
| A | préfectures, SDIS, communes et services publics | RSS/Atom, API ou webhook inscrit sur liste blanche | première source à intégrer ; identité et conditions vérifiées par source |
| A | médias locaux | RSS/Atom autorisé ou accord éditeur | titre, URL et date seulement ; pas d'aspiration de l'article |
| A | [GDELT DOC 2.0](https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/) | découverte d'articles par mots-clés, langue et fenêtre temporelle | index de découverte ; le droit de réutiliser le contenu reste vérifié chez l'éditeur |
| A | FeuxDeForet.fr | API ou export partenaire | aucun scraping ; activation après accord écrit, licence, quotas et procédure de retrait |
| B | [Bluesky](https://docs.bsky.app/docs/advanced-guides/api-directory) | recherche publique puis, si nécessaire, flux réseau filtré | pilote en mode fantôme ; texte social non public dans l'application au premier lot |
| B | [Mastodon](https://docs.joinmastodon.org/methods/timelines/) | comptes officiels et instances locales inscrits sur liste blanche | pas de promesse de recherche mondiale ; disponibilité et authentification varient par instance |
| B | [YouTube Data API](https://developers.google.com/youtube/v3/docs/search/list) | recherche bornée par date, région et éventuellement position déclarée par la vidéo | optionnel, faible cadence ; la géolocalisation est rare et le quota doit être surveillé |
| C | canaux Telegram partenaires | bot ou webhook accepté par l'administrateur du canal | aucun parcours de recherche globale ; partenaires identifiés seulement |
| C | X | API officielle uniquement | différé : l'API est [facturée à l'usage](https://docs.x.com/x-api/getting-started/pricing) et son coût doit être borné |
| C | Meta, TikTok et Reddit | accord ou accès officiel compatible avec le service | différé ; aucun scraping. L'API de recherche TikTok est réservée à des [chercheurs éligibles](https://developers.tiktok.com/products/research-api/) |

La présence publique d'une donnée ne donne pas automatiquement le droit de la
réutiliser. Avant chaque source, la matrice opérateur consigne : propriétaire,
URL de documentation, finalité, base légale retenue, licence/CGU, attribution,
quota, pays d'hébergement, données personnelles reçues, durée de conservation,
contact et procédure de suppression. Les
[recommandations de la CNIL](https://www.cnil.fr/fr/recommandations-reutilisateurs-donnees-internet)
sur la réutilisation de données publiées sur internet constituent le minimum de
revue, sans remplacer une validation juridique.

### Sources exclues du premier lot

- pages web aspirées sans flux ni autorisation explicite ;
- recherche Google/Google News utilisée comme base de données ;
- copies de photos, vidéos, commentaires ou articles ;
- groupes, profils ou messages privés ;
- achats de jeux de données dont la provenance ou le droit de republication
  n'est pas démontré ;
- modèle génératif utilisé pour décider qu'un feu existe.

## Architecture cible

```text
événements existants ──> zones et fenêtres de recherche ──┐
                                                          │
sources autorisées ──> poll-contexte ──> normalisation ───┼─> candidats
                                                          │       │
                                            score explicable <────┘
                                                   │
                               ┌───────────────────┴──────────────────┐
                               v                                      v
                     file de modération                    association retenue
                               │                                      │
                               └──────────────> fiche incident <──────┘

Le chemin « contexte » n'a aucune écriture vers la sévérité ou les alertes.
```

Le collecteur travaille **à partir des événements déjà créés** et de leur
commune, centroïde, rayon d'incertitude et fenêtre temporelle. Il n'effectue pas
une surveillance sociale générale de la population.

### Schéma prévu

La prochaine évolution de schéma sera une nouvelle migration, provisoirement
numérotée **36**. Aucune migration existante ne sera modifiée.

| Table prévue | Contenu minimal |
|---|---|
| `sources_contexte` | code, famille, hôte autorisé, mode d'accès, licence, attribution, état, cadence, dernière réussite ; aucun secret |
| `mentions_contexte` | source, identifiant externe haché, URL canonique, titre/résumé autorisé, date, géographie dérivée, statut, expiration et empreinte de dédoublonnage |
| `evenement_mentions` | événement, mention, score d'association, raisons, distance, écart temporel et décision |
| `contexte_moderation_audit` | décision append-only, motif codifié, date et acteur technique pseudonymisé |

Les clés d'API éventuelles restent dans `public.config`, jamais dans
`sources_contexte` ni dans le dépôt. Toutes les nouvelles tables auront RLS
active, aucune policy publique et des droits révoqués à `PUBLIC`, `anon` et
`authenticated`.

Une route limitée `GET /api/contexte?groupe=<id>` renverra uniquement les
mentions publiables associées au groupe. Elle sera ajoutée à la fonction `api`
existante, bornée à cinq éléments, sans texte social brut, auteur, image,
coordonnée sociale ni donnée de modération. Le quota cible est de 60 requêtes
par minute et par IP.

## Association explicable

Le score mesure **la probabilité que le contenu parle du même incident**, pas
la fiabilité du contenu.

### Conditions préalables

Un candidat doit :

- appartenir à une source activée et autorisée ;
- être postérieur à `debut_ts - 2 h` pour le social ou `debut_ts - 6 h` pour
  les autorités et médias ;
- mentionner une commune/toponyme proche, fournir une coordonnée, ou provenir
  d'un compte officiel local inscrit sur liste blanche ;
- contenir un contexte incendie actuel, sans marqueur évident d'exercice,
  d'archive, de prévention générale ou de fiction.

La fenêtre maximale est de 24 h pour une publication sociale et de 72 h pour
une autorité ou un média. Une information plus tardive peut être reliée
manuellement à un événement clos.

### Barème initial

| Signal d'association | Points |
|---|---:|
| coordonnée dans le rayon d'incertitude de l'événement, majoré de 1 km | +45 |
| commune exacte explicitement reconnue | +35 |
| commune limitrophe | +15 |
| publication à moins de 2 h de l'observation | +25 |
| publication à moins de 6 h | +18 |
| publication à moins de 24 h | +8 |
| toponyme local distinctif | +15 |
| vocabulaire de feu actif cohérent | +10 |
| exercice, archive, anniversaire, prévention ou autre négation forte | −60 |

- **70 et plus** : association automatique possible pour une autorité ou un
  média autorisé ;
- **50 à 69** : file de modération ;
- **moins de 50** : non publié et purge rapide ;
- **toute source sociale** : file de modération pendant le pilote, quel que
  soit le score.

Le type de source reste une étiquette distincte et ne donne pas de points. Un
communiqué officiel générique sur le risque incendie ne doit pas être lié à un
feu uniquement parce qu'il est officiel.

### Dédoublonnage

L'identifiant externe haché, l'URL canonique et une empreinte du titre/texte
normalisé empêchent les doublons. Les syndications, citations et republications
restent rattachées à l'original quand celui-ci est identifiable. Un même
contenu repris par plusieurs comptes n'augmente aucun score.

## Protection des personnes et des contenus

Le premier lot ne conserve pas de charge utile brute après normalisation et
ne stocke pas de nom de particulier. Une URL sociale peut néanmoins identifier
un auteur : elle est donc traitée comme une donnée personnelle et n'est rendue
publique qu'après la revue prévue.

Rétentions proposées :

| Donnée | Durée maximale |
|---|---:|
| candidat rejeté ou sans association | 24 h |
| mention sociale associée | 7 jours après la dernière observation du feu |
| titre/URL d'une autorité ou d'un média | 30 jours après la dernière observation |
| décision d'association sans texte ni auteur | 180 jours |
| charge utile technique en quarantaine après erreur | 24 h |

Une vérification périodique retire les contenus supprimés ou devenus privés.
Le contact RGPD public permet aussi de demander retrait, accès ou rectification.
L'objectif de traitement, les catégories de données, les sources, la base
légale retenue et ces durées devront être ajoutés à la politique de
confidentialité **avant** toute collecte sociale.

## Sécurité technique

- Les URL de collecte viennent exclusivement de la liste blanche opérateur.
- HTTPS est obligatoire ; aucun hôte local, adresse IP littérale ou redirection
  vers un réseau privé n'est accepté.
- Taille de réponse, type MIME, nombre de redirections et durée sont bornés.
- Le contenu est converti en texte simple, normalisé et échappé ; aucun HTML,
  script, image distante ou `iframe` n'entre dans la PWA.
- Les liens publics acceptent uniquement `https:` et affichent leur domaine.
- Toute synthèse automatique future traite le contenu comme non fiable :
  sortie JSON bornée, aucun outil, aucun secret, aucune action et aucune
  décision de détection. Le premier lot fonctionne sans modèle génératif.
- Les textes dévoilant une position, un mouvement ou une tactique des secours
  sont masqués et transmis à la modération.
- Une source peut être coupée immédiatement sans arrêter les autres
  collecteurs.

## Passage en production

### Lot 0 — cadrage et autorisations, 3 à 5 jours

- constituer la liste blanche initiale de 10 à 20 sources officielles/locales ;
- compléter la matrice licence/CGU/RGPD ;
- obtenir au moins un flux officiel ou média autorisé pour le pilote ;
- rédiger la procédure de retrait et mettre à jour la politique de
  confidentialité ;
- figer un jeu de 50 incidents connus pour évaluer les associations.

**Porte de sortie :** aucune collecte ne commence sans propriétaire, finalité,
conditions d'usage, rétention et contact documentés.

### Lot 1 — stockage et collecte fantôme, 5 à 7 jours

- créer la migration 36, les droits, la purge et les tests ;
- ajouter `poll-contexte` avec source désactivée par défaut ;
- collecter autorités, RSS autorisés et GDELT en mode `shadow` ;
- journaliser fraîcheur, quotas, erreurs et volumes dans `runs` ;
- ne rien exposer dans la PWA.

**Porte de sortie :** rejeu Docker complet, tests Deno, zéro écriture vers
`evenements.severite` ou `alertes`, arrêt par source vérifié.

### Lot 2 — association et modération, 5 à 7 jours

- implémenter le score explicable et le dédoublonnage ;
- ajouter la file opérateur sans auteur ni texte inutile ;
- étiqueter les faux rapprochements sur le jeu de référence ;
- mesurer précision, couverture, latence et retraits.

**Porte de sortie :** au moins 90 % d'associations correctes sur l'échantillon
autorité/média ; chaque décision est explicable et auditée.

### Lot 3 — affichage public contrôlé, 4 à 5 jours

- publier d'abord les autorités et médias autorisés ;
- ajouter la route publique limitée et la rubrique de fiche incident ;
- afficher attribution, heure, dernière vérification et raison du lien ;
- tester clavier, lecteur d'écran, faible débit, suppression à la source et
  liens malveillants.

**Porte de sortie :** 100 % des éléments publics sont sourcés et horodatés ;
un retrait est propagé en moins de 6 h et une demande humaine en moins de 24 h.

### Lot 4 — pilote social, 7 à 14 jours

- tester Bluesky et des comptes Mastodon officiels/locaux en mode fantôme ;
- conserver toute publication sociale en modération manuelle ;
- n'afficher que les éléments validés et toujours « non vérifiés » ;
- arrêter automatiquement une source si ses conditions, son quota ou sa
  disponibilité deviennent incompatibles.

**Porte de sortie :** au moins 95 % des éléments sociaux rendus publics sont
liés au bon incident sur un échantillon revu ; aucune donnée privée ou contenu
supprimé n'est publié.

YouTube, X, Meta, TikTok, Reddit et les canaux partenaires ne sont évalués
qu'après ces quatre lots. Une notification « nouvelle information locale »
reste hors périmètre : elle ferait l'objet d'un consentement séparé et ne
reprendrait jamais le niveau sonore ou l'urgence d'une alerte feu.

## Indicateurs de décision

- précision des associations par famille de source ;
- taux de candidats envoyés en modération et taux de rejet ;
- couverture : proportion d'événements ayant au moins une information locale ;
- délai entre publication externe, collecte et association ;
- doublons évités et reprises d'un même original ;
- éléments retirés, délai de retrait et demandes RGPD ;
- disponibilité, quota consommé et coût par source ;
- taille de réponse et latence p95 de `/api/contexte` ;
- faux effets sur la détection : la valeur attendue est strictement zéro.

## Fichiers à modifier lors de l'implémentation

- nouvelle migration 36 : tables, RLS, privilèges, purge et tâches `pg_cron` ;
- nouvelle Edge Function interne `poll-contexte` et tests ;
- fonction `api` : route publique bornée ;
- `web/index.html` : rubrique, explications, états vide/erreur/hors ligne ;
- `web/confidentialite.html` : finalité, sources, base légale et droits ;
- `docs/CONTEXTE.md`, `docs/EXPLOITATION.md`, `docs/SECURITE.md`,
  `docs/PLAN_AMELIORATION.md` et `README.md`.

Le lot n'est considéré livré qu'après `deno task verif`, `supabase db start`,
`git diff --check`, déploiement, vérification des migrations et contrôle externe
de la route et de la PWA.
