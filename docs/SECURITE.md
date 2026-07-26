# Modèle de sécurité

## Principe

Aucune table n'est accessible directement. RLS est active partout **sans aucune
policy** : la clé publique du projet, par nature exposée, ne donne donc accès à
rien. Tout passe par les Edge Functions, qui utilisent le service role et
appliquent leurs propres contrôles.

| Surface | Contrôle |
|---|---|
| `api` | jeton d'abonné aléatoire de 24 octets (`x-token`), portée limitée à ses propres zones et canaux |
| `signalement` | lecture publique limitée par IP ; écriture par `x-token`, appareil Web Push actif et quotas personne/réseau |
| `signalement/moderation` | `x-admin-key`, audit de chaque lecture/décision, données agrégées sans identité |
| `api/sante-publique` | lecture publique limitée ; fraîcheur agrégée sans secret, jeton ni donnée d'abonné |
| collecteurs, sondes et `dispatch` | `x-admin-key`, comparaison à temps constant, ou appel interne porteur du service role |
| `load-communes` | `x-admin-key`, ou service role pour le chargement à la demande depuis `api` |
| Tables `public.*` | RLS active, zéro policy, `revoke all` sur `anon`/`authenticated` |
| Fonctions `public.*` | `revoke all from public, anon, authenticated` — `service_role` uniquement |
| Secrets | table `config`, jamais dans le dépôt (`.gitignore` couvre `.env` et `vapid*.json`) |

## Piège corrigé : le droit PUBLIC implicite

Postgres accorde `EXECUTE` à `PUBLIC` sur toute fonction nouvellement créée.
Écrire `revoke all on function f from anon, authenticated` **ne suffit pas** :
`anon` conserve le droit hérité de `PUBLIC`.

Conséquence avant correctif, détectée par le linter Supabase : `purger()`
(suppression de données) et `appeler_fonction()` (vecteur SSRF interne) étaient
appelables par quiconque connaissait la référence du projet.

La migration `11_durcissement_droits` révoque `PUBLIC` sur toutes les fonctions
du schéma et modifie les privilèges par défaut pour les créations futures.

Vérification :

```bash
curl -X POST "$URL/rest/v1/rpc/purger" \
  -H "apikey: $CLE_PUBLIQUE" -H "Authorization: Bearer $CLE_PUBLIQUE" \
  -H "Content-Type: application/json" -d '{}'
# attendu : 401 permission denied for function purger
```

## Audit

```
Supabase Studio > Advisors > Security
```

Doit ne contenir que des `INFO` du type « RLS Enabled No Policy » : c'est le
comportement voulu, l'absence de policy **est** la protection.

## Points d'attention

- Le **jeton d'abonné** est un porteur : quiconque l'obtient voit et modifie les
  zones et canaux de cet abonné. Il ne donne accès à aucune donnée d'un autre
  abonné, ni à l'administration.
- La **clé d'administration** permet de déclencher la collecte et l'envoi
  d'alertes. Elle est acceptée uniquement dans l'en-tête `x-admin-key`, jamais
  dans l'URL. La faire tourner via
  `update public.config set v = … where k = 'admin_key'`.

## Anti-abus — ouverture au public

### Canal unique Web Push

Le produit accepte uniquement un abonnement Web Push produit par le navigateur.
Son endpoint HTTPS et ses clés cryptographiques sont validés avant stockage.
Cette conception évite qu'un utilisateur puisse fournir la destination d'un
tiers et transformer le service en relais de spam.

La protection existe à quatre niveaux :

- l'interface ne propose que l'activation sur l'appareil courant ;
- `POST /api/canal` répond HTTP 410 pour tout type autre que `webpush` ;
- `dispatch` refuse toute ligne qui ne serait pas Web Push ;
- la migration 35 supprime les destinations e-mail/Telegram, leurs secrets et
  impose `check (type = 'webpush')` dans PostgreSQL.

### Quotas

| Route | Clé | Plafond |
|---|---|---|
| `inscription` | IP | 5 / heure |
| `communes` | IP | 60 / minute |
| `canal` | abonné | 10 / heure |
| `zone` | abonné | 15 / heure |
| `test` | abonné | 5 / heure |
| `reglages` | abonné | 30 / heure |
| `etat` | abonné | 120 / heure |
| `informations` | IP | 120 / heure |
| `carte` (indices corrélés) | IP | 120 / minute |
| `compte-exporter` | abonné | 3 / 24 h |
| `compte-supprimer` | abonné | 3 / 24 h |
| carte des signalements | IP | 120 / minute |
| état public des sources | IP | 60 / minute |
| création de signalement | abonné | 3 / heure |
| création de signalement | IP/réseau | 6 / heure |
| contestation | abonné | 10 / heure |
| contestation | IP/réseau | 20 / heure |

### Plafonds par abonné

10 zones, 8 appareils Web Push. Limite la charge de collecte et la surface
d'abus.

### Autres durcissements

- Les erreurs internes ne sont plus renvoyées au client (`erreur interne`), pour
  ne pas divulguer la structure de la base ; le détail va dans les logs.
- `reglages` vérifie que la zone modifiée est bien rattachée à l'abonné, sinon
  n'importe qui pouvait changer la sensibilité de la zone d'un autre.
- Longueurs bornées sur toutes les entrées texte, jeton contrôlé en longueur
  avant requête.
- Les libellés et erreurs renvoyés par le serveur sont échappés avant toute
  insertion dans `innerHTML` dans la PWA.
- La carte corrélée n'expose que des pixels satellites, des groupes citoyens
  déjà confirmés et des mentions de corroboration. Elle n'expose ni identité,
  ni canal, ni IP, ni trajectoire aérienne brute. Les requêtes sont bornées à
  72 h, 500 groupes et un quota par IP.
- Les abonnements Web Push refusent les endpoints non HTTPS, les hôtes locaux,
  les adresses IP littérales et les clés cryptographiques mal formées.
- `purger()` supprime les abonnés sans canal ni zone inactifs depuis 60 jours :
  minimisation des données.
- L'inscription exige un consentement explicite et stocke la version acceptée
  et sa date.
- L'abonné peut exporter ses données ou supprimer son compte. La suppression
  recalcule les preuves citoyennes et les contestations afin qu'une action
  effacée ne continue ni à produire ni à rejeter une alerte. Les clés de quota
  contenant son identifiant sont également retirées.
- Les champs structurés d'un signalement (heure, intensité perçue, végétation,
  proximité d'habitations, certitude) ne sont accessibles publiquement que sous
  forme agrégée. Le détail et la décision de modération sont réservés à
  l'auteur authentifié.
- `signalement_moderation_audit` est append-only depuis l'application, sous RLS
  sans policy publique. Il ne contient ni IP en clair ni texte utilisateur.
- Le texte libre susceptible de révéler position, mouvement ou stratégie des
  secours est refusé avant stockage.
- Les appels humains par `admin_key` sont journalisés avec une IP hachée et un
  user-agent pendant 180 jours. Un échec d'écriture du journal ne bloque pas une
  opération de sécurité urgente, mais est consigné dans les logs.
- La console de modération ne stocke pas `admin_key` dans `localStorage` ou
  `sessionStorage`. Une actualisation impose de la ressaisir. Elle n'expose ni
  abonné, ni canal, ni IP et ne permet que maintien motivé, rejet ou expiration.
- La géolocalisation « autour de moi » est calculée dans le navigateur. Elle
  n'est envoyée que lorsque l'utilisateur choisit explicitement d'enregistrer
  un point de référence privé.
- La recherche publique de lieu transmet uniquement un nom de commune ou un
  code postal. La réponse ajoute le centre communal public de
  `geo.api.gouv.fr`; aucune position précise du terminal ni jeton d'abonné
  n'est envoyé sur cette route.
- Les liens partagés d'incident contiennent une clé dérivée de coordonnées et
  d'un horaire déjà publics, jamais un jeton d'abonné.
- Le cache hors ligne contient uniquement le shell statique, Leaflet, des
  incidents publics et des tuiles cartographiques bornées ; les réponses
  authentifiées des Edge Functions ne sont jamais interceptées par le service
  worker.

## Ce qui reste à faire avant une ouverture large

1. **Identité et validation juridique** — la politique de confidentialité et
   les droits techniques existent et le contact public
   `qevedeveq@gmail.com` est livré par la migration 28. L'identité légale
   complète de l'exploitant et le texte doivent encore être validés pour le
   contexte réel de diffusion.
2. **Responsabilité** — faire reposer une décision d'évacuation sur ce service
   serait dangereux. Le cadre juridique d'un service d'alerte non officiel
   mérite un avis professionnel avant diffusion large. Ceci n'est pas un conseil
   juridique.
3. **Rotation de `admin_key`** — définir une cadence opératoire et révoquer
   immédiatement la valeur en cas de fuite.

## Signalements citoyens — surface d'abus spécifique

Ouvrir le signalement à tous crée un risque différent du spam : **quelques faux
positifs suffisent à ce que les gens cessent de croire aux vraies alertes.** Sur
un service de sécurité, la perte de confiance est plus grave qu'une nuisance.

La création et la contestation exigent un compte actif possédant au moins un
appareil Web Push actif et vérifié. Une inscription avec un simple jeton local
ne suffit donc pas.

### Ce qui est en place

| Garde-fou | Effet |
|---|---|
| Compte et appareil notifiable requis | rend le déclarant joignable et bloque les comptes créés sans aucune vérification |
| Index unique `(abonne_id, groupe_id)` | un abonné ne compte qu'une fois par départ de feu |
| 2 personnes **et** 2 réseaux, ou 3 personnes | bloque l'auto-confirmation à deux appareils sur le même réseau |
| 3 signalements/h par personne, 6/h par réseau | dissuade la fabrication de comptes en série |
| Périmètre géographique | rejette les positions hors France et outre-mer |
| Sévérité plafonnée à `alerte` | un signalement, même confirmé, ne réveille pas pendant les heures silencieuses |
| Étiquetage explicite | tout message dit « signalement de témoins, non vérifié » |
| IP hachée avec un sel | jamais stockée en clair — minimisation RGPD |
| Contestation collective | un tiers peut signaler une erreur ; rejet au même quorum que la confirmation |
| Auto-contestation interdite | l'auteur d'un groupe ne peut pas contribuer à son rejet |
| Fiabilité agrégée | l'export restitue confirmés, corroborés et rejetés sans profilage caché |

### Ce qui reste ouvert

- **Comptes en série.** Le jeton est gratuit et instantané par choix : c'est ce
  qui rend le signalement utilisable au moment où ça compte. Un attaquant
  déterminé peut créer trois comptes depuis trois réseaux. Les quotas ralentissent
  sans empêcher.
- **Réputation non pondérée.** L'historique de fiabilité est calculé et
  exportable, mais ne modifie volontairement pas encore le vote : une règle de
  pondération opaque pourrait défavoriser un témoin légitime après une erreur.

### Recommandation avant une ouverture large

Surveiller le rapport entre signalements confirmés et signalements ensuite
corroborés par un satellite. Une divergence durable indiquerait soit un abus,
soit un seuil mal réglé. La requête :

```sql
select count(*) filter (where e.origine = 'mixte')  as corrobores,
       count(*) filter (where e.origine = 'citoyen') as jamais_corrobores
from public.evenements e
where e.debut_ts > now() - interval '30 days';
```
