-- ===================================================================
--  ISOLATION DES ZONES ET RESERVATION ATOMIQUE DES ALERTES
-- -------------------------------------------------------------------
--  Deux invariants de production sont corriges sans modifier les
--  migrations deja livrees :
--
--  1. une configuration de zone est partageable uniquement si TOUS ses
--     reglages sont identiques. La sensibilite fait donc partie de la cle ;
--  2. un dispatch reserve un lot avant tout effet Web Push externe.
--     Deux executions concurrentes ne peuvent plus envoyer la meme ligne.
-- ===================================================================

-- ---------- zones : la sensibilite appartient a la configuration ----------

alter table public.zones
  drop constraint if exists zones_commune_code_buffer_m_inclure_limitrophes_key;

alter table public.zones
  add constraint zones_configuration_key
  unique (commune_code, buffer_m, inclure_limitrophes, sensibilite);

create or replace function public.upsert_zone(
  p_code text,
  p_limitrophes boolean default true,
  p_buffer_m integer default 3000,
  p_sensibilite text default 'equilibre'
) returns public.zones
language plpgsql
security definer
set search_path = public
as $$
declare z public.zones; c public.communes;
begin
  select * into c from public.communes where code = p_code;
  if c is null then
    raise exception 'commune % non chargee : appelez load-communes pour le departement', p_code;
  end if;

  insert into public.zones (
    nom, commune_code, inclure_limitrophes, buffer_m, sensibilite
  )
  values (c.nom, p_code, p_limitrophes, p_buffer_m, p_sensibilite)
  on conflict (commune_code, buffer_m, inclure_limitrophes, sensibilite)
    do update set actif = true
  returning * into z;

  return public.refresh_zone_geom(z.id);
end;
$$;

-- Reconfigure une zone pour un seul abonne. Si la configuration cible
-- existe deja, elle est partagee sans risque ; sinon une zone est creee.
-- L'ancienne zone n'est desactivee que lorsqu'elle n'a plus d'abonne.
create or replace function public.reconfigurer_zone_abonne(
  p_abonne uuid,
  p_zone uuid,
  p_limitrophes boolean,
  p_buffer_m integer,
  p_sensibilite text
) returns public.zones
language plpgsql
security definer
set search_path = public
as $$
declare
  ancienne public.zones;
  cible public.zones;
begin
  if not exists (
    select 1 from public.zone_abonnes
    where abonne_id = p_abonne and zone_id = p_zone
  ) then
    raise exception 'zone non rattachee a cet abonne';
  end if;

  select * into ancienne from public.zones where id = p_zone;
  if ancienne is null then raise exception 'zone introuvable'; end if;

  cible := public.upsert_zone(
    ancienne.commune_code,
    coalesce(p_limitrophes, ancienne.inclure_limitrophes),
    coalesce(p_buffer_m, ancienne.buffer_m),
    coalesce(p_sensibilite, ancienne.sensibilite)
  );

  if cible.id <> ancienne.id then
    insert into public.zone_abonnes (zone_id, abonne_id)
    values (cible.id, p_abonne)
    on conflict do nothing;

    delete from public.zone_abonnes
    where zone_id = ancienne.id and abonne_id = p_abonne;

    update public.zones
       set actif = false
     where id = ancienne.id
       and not exists (
         select 1 from public.zone_abonnes za where za.zone_id = ancienne.id
       );
  end if;

  return cible;
end;
$$;

-- ---------- alertes : reservation avec bail ----------

alter table public.alertes
  drop constraint if exists alertes_statut_check;

alter table public.alertes
  add constraint alertes_statut_check
  check (statut in ('en_attente', 'en_cours', 'envoye', 'echec', 'ignore'));

alter table public.alertes
  add column if not exists claim_id uuid,
  add column if not exists claimed_at timestamptz;

create index if not exists alertes_claim_idx
  on public.alertes (claimed_at)
  where statut = 'en_cours';

comment on column public.alertes.claim_id is
  'Identifiant du lot qui a reserve la ligne avant envoi Web Push.';
comment on column public.alertes.claimed_at is
  'Debut du bail de reservation ; un bail de plus de cinq minutes est recuperable.';

create or replace function public.reserver_alertes(p_limite integer default 200)
returns setof public.alertes
language plpgsql
security definer
set search_path = public, extensions
as $$
declare v_lot uuid := gen_random_uuid();
begin
  return query
  with candidates as (
    select a.id
      from public.alertes a
     where (
       (
         a.statut = 'en_attente'
         and a.tentatives < 5
         and a.prochaine_tentative_at <= now()
       )
       or (
         a.statut = 'en_cours'
         and a.claimed_at < now() - interval '5 minutes'
       )
     )
       and a.created_at > now() - case when a.type = 'alerte'
                                        then interval '2 hours'
                                        else interval '24 hours' end
     order by
       case a.severite when 'critique' then 0 when 'alerte' then 1 else 2 end,
       a.created_at
     for update skip locked
     limit greatest(1, least(p_limite, 500))
  ),
  reserved as (
    update public.alertes a
       set statut = 'en_cours',
           claim_id = v_lot,
           claimed_at = now()
      from candidates c
     where a.id = c.id
    returning a.*
  )
  select * from reserved;
end;
$$;

create or replace function public.liberer_alertes(
  p_lot uuid,
  p_ids uuid[]
) returns integer
language sql
security definer
set search_path = public
as $$
  with released as (
    update public.alertes
       set statut = 'en_attente',
           claim_id = null,
           claimed_at = null
     where claim_id = p_lot
       and statut = 'en_cours'
       and id = any(coalesce(p_ids, '{}'::uuid[]))
    returning 1
  )
  select count(*)::integer from released
$$;

-- Les fonctions et tables publiques restent reservees au service role.
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated',
      f.sig
    );
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

revoke all on all tables in schema public from anon, authenticated;
