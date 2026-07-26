# Consignes de maintenance
Ce dépôt pilote un système d'alerte incendie. Toute modification doit préserver
la traçabilité, les garde-fous de sécurité et la cohérence entre le code et la
documentation.

## Contexte à lire

Avant toute modification, lire :

1. `docs/CONTEXTE.md` — architecture, état de livraison, invariants et risques ;
2. `docs/EXPLOITATION.md` — configuration et procédures de production ;
3. `docs/SECURITE.md` — modèle d'accès et limites avant ouverture large ;
4. `README.md` — comportement présenté aux utilisateurs.

## Règles de modification

- Une migration déjà appliquée en production est immuable : créer une nouvelle
  migration corrective. L'état de livraison connu est consigné dans
  `docs/CONTEXTE.md`.
- Ne jamais ajouter de secret au dépôt. Les secrets applicatifs vivent dans
  `public.config`; les secrets de déploiement vivent dans GitHub Actions.
- Conserver les invariants listés dans `docs/CONTEXTE.md`, notamment RLS sans
  policy publique, séparation des preuves et idempotence des alertes.
- Toute donnée injectée dans du HTML doit être échappée.
- Toute nouvelle route publique doit avoir authentification ou quota explicite.
- Toute nouvelle tâche planifiée doit être déclarée dans une migration et
  documentée dans `docs/CONTEXTE.md` et `docs/EXPLOITATION.md`.
- **N'afficher à l'utilisateur que des grandeurs mesurées.** Avant d'ajouter un
  indicateur, écrire d'où vient chaque terme du calcul. Si aucune source ne
  mesure la grandeur, ne pas l'estimer : ne rien afficher. Ne pas prévoir de
  valeur de repli rassurante quand une source externe ne répond pas — écrire
  que la valeur est indisponible. Sur un service d'alerte, un chiffre plausible
  mais fabriqué est repris tel quel par la personne qui le lit.
- **Ne pas livrer de calcul côté client que rien ne peut alimenter.** Vérifier
  que la donnée d'entrée existe vraiment : colonne en base, champ dans la
  réponse d'API, clé de jointure compatible. Une fonction sophistiquée branchée
  sur du vide est plus coûteuse à découvrir qu'une fonctionnalité absente.

## Vérifications minimales

Depuis `supabase/functions` :

```bash
deno task verif
```

Depuis la racine, avec Docker et la CLI Supabase :

```bash
supabase db start
```

Vérifier aussi :

```bash
git diff --check
```

Si l'environnement local ne possède pas Deno, Docker ou la CLI Supabase,
indiquer clairement les vérifications non exécutées et laisser GitHub Actions
les effectuer avant tout déploiement.

Les tests d'interface vivent dans `supabase/functions/_tests` mais portent sur
`web/` : une modification de la PWA doit donc lancer `deno task verif`, même si
aucun fichier de `supabase/` n'a bougé. Les deux workflows GitHub le font
désormais, mais le contrôle local reste plus rapide qu'un aller-retour en
production.

## Mise à jour systématique du contexte

Après une évolution fonctionnelle, de sécurité, de schéma, de source externe ou
de déploiement :

- mettre à jour `docs/CONTEXTE.md` ;
- mettre à jour le README si le comportement utilisateur change ;
- mettre à jour `docs/EXPLOITATION.md` si la configuration, le cron ou les
  procédures changent ;
- mettre à jour `docs/SECURITE.md` si la surface d'accès ou les données traitées
  changent ;
- ajouter ou adapter les tests concernés.
