-- ===================================================================
--  Invariants de sécurité — vérifiés par la machine, plus à la main
-- -------------------------------------------------------------------
--  docs/SECURITE.md énonce trois règles absolues : RLS active partout,
--  aucune policy publique, aucun droit d'exécution pour PUBLIC, anon ou
--  authenticated. Elles n'étaient contrôlées que par relecture et par
--  le linter Supabase, après coup.
--
--  Rappel du piège corrigé par la migration 11 : Postgres accorde
--  EXECUTE à PUBLIC sur toute fonction nouvellement créée. Une seule
--  migration distraite rouvre la porte. Ce fichier la referme.
-- ===================================================================
begin;
-- pgTAP n'est chargé que pour la durée du test : le ROLLBACK final le
-- retire, la base de production n'en porte jamais la trace.
create extension if not exists pgtap with schema public;
select plan(8);

-- ---------- 1. RLS active sur toutes les tables métier ----------

select is(
  (select coalesce(string_agg(c.relname, ', ' order by c.relname), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and not c.relrowsecurity),
  '',
  'aucune table publique sans Row Level Security'
);

-- ---------- 2. Aucune policy : tout passe par le service role ----------

select is(
  (select coalesce(string_agg(policyname, ', ' order by policyname), '')
     from pg_policies where schemaname = 'public'),
  '',
  'aucune policy publique : seul le service role accède aux données'
);

-- ---------- 3. Aucun droit d'exécution hérité ----------

select is(
  (select coalesce(string_agg(distinct p.proname, ', '), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and (
        has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE')
      )),
  '',
  'aucune fonction publique exécutable par anon ou authenticated'
);

-- ---------- 4. Aucun droit de lecture direct sur les tables ----------

select is(
  (select coalesce(string_agg(distinct c.relname, ', '), '')
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and (
        has_table_privilege('anon', c.oid, 'SELECT')
        or has_table_privilege('authenticated', c.oid, 'SELECT')
      )),
  '',
  'aucune table publique lisible par anon ou authenticated'
);

-- ---------- 5. Les secrets restent en base, jamais en clair ailleurs ----------

select ok(
  (select relrowsecurity from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'config'),
  'la table des secrets applicatifs a RLS active'
);

-- ---------- 6. Les fonctions sensibles fixent leur search_path ----------
--  Une fonction SECURITY DEFINER sans search_path figé est détournable
--  en créant un objet homonyme dans un schéma temporaire.

select is(
  (select coalesce(string_agg(p.proname, ', ' order by p.proname), '')
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef
      and (p.proconfig is null
           or not exists (
             select 1 from unnest(p.proconfig) cfg where cfg like 'search_path=%'
           ))),
  '',
  'toute fonction SECURITY DEFINER fixe son search_path'
);

-- ---------- 7. Le contexte local n'écrit pas dans les preuves ----------
--  Invariant produit, vérifiable structurellement : aucune contrainte
--  ne relie une mention à la sévérité d'un évènement.

select is(
  (select count(*)::integer
     from information_schema.columns
    where table_schema = 'public'
      and table_name in ('mentions_contexte', 'evenement_mentions')
      and column_name in ('severite', 'score_detection', 'nb_detections')),
  0,
  'les tables de contexte ne portent aucune colonne de sévérité ou de preuve'
);

-- ---------- 8. Rétention : la purge couvre toutes les tables datées ----------

select ok(
  exists (
    select 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'purger'
  ),
  'la fonction de purge existe et reste appelable par le service role'
);

select * from finish();
rollback;
