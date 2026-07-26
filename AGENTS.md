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
