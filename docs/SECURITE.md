# Modèle de sécurité

## Principe

Aucune table n'est accessible directement. RLS est active partout **sans aucune
policy** : la clé publique du projet, par nature exposée, ne donne donc accès à
rien. Tout passe par les Edge Functions, qui utilisent le service role et
appliquent leurs propres contrôles.

| Surface | Contrôle |
|---|---|
| `api` | jeton d'abonné aléatoire de 24 octets (`x-token`), portée limitée à ses propres zones et canaux |
| `poll-firms`, `dispatch`, `load-communes` | `x-admin-key`, comparaison à temps constant, ou appel interne porteur du service role |
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
  d'alertes. La faire tourner via `update public.config set v = … where k = 'admin_key'`.
- Le **jeton Telegram** permet d'écrire à tous les abonnés du bot. Le révoquer
  auprès de @BotFather en cas de fuite.

## Anti-abus — ouverture au public

Un service d'alerte accessible à tous devient, sans garde-fous, un **relais de
spam** : n'importe qui pouvait attacher l'adresse e-mail d'un tiers à son compte
et déclencher un envoi. Au-delà du harcèlement possible, l'adresse d'expédition
(le Gmail de l'exploitant) aurait rapidement été placée sur liste noire, ce qui
aurait fait tomber le canal e-mail pour **tous** les utilisateurs.

### Double opt-in sur l'e-mail

Un canal e-mail est créé avec `verifie = false`. Un code à six chiffres, valable
30 minutes, est envoyé à l'adresse. Tant qu'il n'est pas saisi :

- `mettre_en_file_alertes()` ignore le canal — aucune alerte n'est produite ;
- la route `test` ne le voit pas.

Cinq essais de code maximum, puis il faut en redemander un.

Push et Telegram sont vérifiés par construction : l'abonnement push est produit
par l'appareil lui-même, et le `chat_id` Telegram provient d'un `/start` envoyé
par l'utilisateur depuis son propre compte. Aucun tiers ne peut être ciblé.

### Quotas

| Route | Clé | Plafond |
|---|---|---|
| `inscription` | IP | 5 / heure |
| `communes` | IP | 60 / minute |
| `canal` | abonné | 10 / heure |
| `canal` (e-mail) | **adresse visée** | 2 / 24 h, tous abonnés confondus |
| `canal-verifier` | abonné | 20 / heure |
| `zone` | abonné | 15 / heure |
| `test` | abonné | 5 / heure |
| `reglages` | abonné | 30 / heure |
| `etat` | abonné | 120 / heure |

Le quota par **adresse visée** est le plus important : il empêche d'utiliser
plusieurs comptes pour harceler une même personne.

### Plafonds par abonné

10 zones, 8 canaux. Limite la charge de collecte et la surface d'abus.

### Autres durcissements

- Les erreurs internes ne sont plus renvoyées au client (`erreur interne`), pour
  ne pas divulguer la structure de la base ; le détail va dans les logs.
- `reglages` vérifie que la zone modifiée est bien rattachée à l'abonné, sinon
  n'importe qui pouvait changer la sensibilité de la zone d'un autre.
- Longueurs bornées sur toutes les entrées texte, jeton contrôlé en longueur
  avant requête.
- `purger()` supprime les abonnés sans canal ni zone inactifs depuis 60 jours :
  minimisation des données.

## Ce qui reste à faire avant une ouverture large

1. **Mentions légales et politique de confidentialité** — le service traite des
   adresses e-mail et des données de localisation approximative (commune
   surveillée). RGPD applicable : finalité, durée de conservation, droit
   d'effacement, responsable de traitement identifié.
2. **Avertissement affiché et accepté** — la latence de 2 à 3 h et le fait que
   le service ne remplace ni FR-Alert ni le 18/112 doivent être visibles avant
   toute inscription, pas seulement en bas de page.
3. **Responsabilité** — faire reposer une décision d'évacuation sur ce service
   serait dangereux. Le cadre juridique d'un service d'alerte non officiel
   mérite un avis professionnel avant diffusion large. Ceci n'est pas un conseil
   juridique.
4. **Expéditeur e-mail dédié** — un domaine avec SPF, DKIM et DMARC, et un
   fournisseur transactionnel, plutôt qu'un Gmail personnel qui plafonne à
   ~500 envois par jour.
5. **Journal d'audit** des accès administrateur et rotation de `admin_key`.

## Signalements citoyens — surface d'abus spécifique

Ouvrir le signalement à tous crée un risque différent du spam : **quelques faux
positifs suffisent à ce que les gens cessent de croire aux vraies alertes.** Sur
un service de sécurité, la perte de confiance est plus grave qu'une nuisance.

### Ce qui est en place

| Garde-fou | Effet |
|---|---|
| Jeton d'abonné requis | rend les quotas et la détection d'auto-confirmation possibles ; reste gratuit et instantané |
| Index unique `(abonne_id, groupe_id)` | un abonné ne compte qu'une fois par départ de feu |
| 2 personnes **et** 2 réseaux, ou 3 personnes | bloque l'auto-confirmation à deux appareils sur le même réseau |
| 3 signalements/h par personne, 6/h par réseau | dissuade la fabrication de comptes en série |
| Périmètre géographique | rejette les positions hors France et outre-mer |
| Sévérité plafonnée à `alerte` | un signalement, même confirmé, ne réveille pas pendant les heures silencieuses |
| Étiquetage explicite | tout message dit « signalement de témoins, non vérifié » |
| IP hachée avec un sel | jamais stockée en clair — minimisation RGPD |

### Ce qui reste ouvert

- **Comptes en série.** Le jeton est gratuit et instantané par choix : c'est ce
  qui rend le signalement utilisable au moment où ça compte. Un attaquant
  déterminé peut créer trois comptes depuis trois réseaux. Les quotas ralentissent
  sans empêcher.
- **Pas de modération.** Aucun mécanisme ne permet à un tiers de rejeter un
  signalement manifestement faux. À prévoir si l'usage s'élargit : un bouton
  « ce signalement est erroné » avec le même seuil de confirmation.
- **Pas d'historique de fiabilité.** Un compte qui a déjà produit des
  signalements infirmés par le satellite devrait peser moins. Piste naturelle
  d'amélioration.

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
