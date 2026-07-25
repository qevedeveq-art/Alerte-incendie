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
