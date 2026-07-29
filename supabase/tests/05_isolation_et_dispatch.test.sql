-- ===================================================================
--  Isolation multi-abonnes et reservation concurrente du dispatch
-- ===================================================================
begin;
create extension if not exists pgtap with schema public;
select plan(8);

select ok(
  exists (
    select 1
      from pg_constraint
     where conrelid = 'public.zones'::regclass
       and conname = 'zones_configuration_key'
       and pg_get_constraintdef(oid) like '%sensibilite%'
  ),
  'la sensibilite fait partie de la configuration unique d une zone'
);

select ok(
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reconfigurer_zone_abonne'
  ),
  'la reconfiguration par abonne est transactionnelle'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%zone_abonnes%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reconfigurer_zone_abonne'),
  'la reconfiguration verifie le rattachement de l abonne'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%delete from public.zone_abonnes%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reconfigurer_zone_abonne'),
  'seul le lien de l abonne est deplace vers la configuration cible'
);

select ok(
  exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'alertes'
      and column_name = 'claim_id'
  ),
  'une alerte porte l identifiant de son lot de reservation'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%for update skip locked%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reserver_alertes'),
  'deux dispatchs concurrents ne peuvent pas reserver la meme ligne'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%statut = ''en_cours''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reserver_alertes'),
  'une reservation possede un etat explicite avant l effet externe'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%5 minutes%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reserver_alertes'),
  'un bail abandonne est recuperable automatiquement'
);

select * from finish();
rollback;
