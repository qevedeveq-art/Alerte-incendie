-- ===================================================================
--  JOURNAL DES CRENEAUX TRAITES
--  Le dedoublonnage ne peut pas se deduire des detections inserees :
--  un creneau sans aucun feu dans l'emprise n'insere rien, et serait
--  donc retelecharge et redecode indefiniment. Six decodages HDF5
--  toutes les 15 minutes finiraient par depasser le temps d'execution
--  d'une Edge Function.
-- ===================================================================
create table public.creneaux_traites (
  source     text        not null,
  slot       text        not null,          -- AAAAMMJJHHMM UTC
  traite_at  timestamptz not null default now(),
  pixels     integer,                       -- pixels de feu sur tout le disque
  retenus    integer,                       -- pixels conserves dans l'emprise
  primary key (source, slot)
);
create index creneaux_traites_at_idx on public.creneaux_traites (traite_at desc);
alter table public.creneaux_traites enable row level security;

comment on table public.creneaux_traites is
  'Creneaux satellite deja telecharges et decodes, pour eviter de refaire le travail.';

create or replace function public.creneaux_a_traiter(p_source text, p_slots text[])
returns text[]
language sql stable security definer set search_path = public
as $$
  select coalesce(array_agg(s order by s desc), '{}')
  from unnest(p_slots) s
  where not exists (
    select 1 from public.creneaux_traites c
    where c.source = p_source and c.slot = s);
$$;

create or replace function public.marquer_creneau(
  p_source text, p_slot text, p_pixels integer default null, p_retenus integer default null
) returns void
language sql security definer set search_path = public
as $$
  insert into public.creneaux_traites (source, slot, pixels, retenus)
  values (p_source, p_slot, p_pixels, p_retenus)
  on conflict (source, slot) do update
    set traite_at = now(), pixels = excluded.pixels, retenus = excluded.retenus;
$$;

-- Purge : 7 jours suffisent, les creneaux plus anciens ne seront jamais rejoues
create or replace function public.purger()
returns void language sql security definer set search_path = public as $$
  delete from public.detections where acq_ts < now() - interval '90 days';
  delete from public.evenements where statut = 'clos' and clos_at < now() - interval '365 days';
  delete from public.runs    where started_at < now() - interval '30 days';
  delete from public.alertes where created_at < now() - interval '180 days';
  delete from public.quotas  where fenetre < now() - interval '2 days';
  delete from public.creneaux_traites where traite_at < now() - interval '7 days';
  delete from public.abonnes a
   where coalesce(a.last_seen_at, a.created_at) < now() - interval '60 days'
     and not exists (select 1 from public.canaux c where c.abonne_id = a.id)
     and not exists (select 1 from public.zone_abonnes z where z.abonne_id = a.id);
$$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;;