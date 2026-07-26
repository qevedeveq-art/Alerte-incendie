-- ===================================================================
--  CORROBORATION AERIENNE (ADS-B)
-- ---------------------------------------------------------------------
--  Un bombardier d'eau ou un helicoptere bombardier d'eau qui tourne en
--  hippodrome a basse altitude au-dessus d'un point est une confirmation
--  quasi certaine d'un feu reel ET significatif : ces appareils ne
--  decollent pas pour un feu de broussaille. Le signal arrive souvent
--  AVANT le passage polaire suivant.
--
--  Deux precautions de conception :
--
--  1. L'ADS-B ne CREE JAMAIS un evenement. Un appareil en transit, en
--     entrainement ou en mission sanitaire produirait des faux positifs.
--     Il ne fait que se rattacher a un evenement deja actif a proximite.
--
--  2. Il n'incremente PAS nb_detections. Ce n'est pas un pixel chaud, et
--     la migration 20 a justement separe les unites de preuve. Il ajoute
--     'ADSB' au tableau des sources, ce qui suffit a declencher la regle
--     « deux sources concordantes -> critique » — le comportement voulu.
-- ===================================================================

create table if not exists public.observations_aero (
  id          bigserial primary key,
  icao24      text not null,
  indicatif   text,
  vu_at       timestamptz not null,
  geom        geography(Point, 4326) not null,
  altitude_m  numeric,
  vitesse_kmh numeric,
  fingerprint text not null unique,
  ingested_at timestamptz not null default now()
);
create index if not exists obs_aero_geom_idx on public.observations_aero using gist (geom);
create index if not exists obs_aero_vu_idx   on public.observations_aero (vu_at desc);
alter table public.observations_aero enable row level security;

comment on table public.observations_aero is
  'Positions d''aeronefs de lutte contre l''incendie (ADS-B). Sert uniquement a corroborer un evenement existant.';

-- ---------------------------------------------------------------------
--  Rattachement.
--  Exigences cumulatives, volontairement strictes :
--    - au moins 2 observations du meme appareil
--    - dans les 30 dernieres minutes
--    - a moins de 4 km d'un evenement actif
--  Deux positions basses et proches dans le temps traduisent un appareil
--  qui reste sur zone, pas un appareil qui la traverse.
-- ---------------------------------------------------------------------
create or replace function public.corroborer_par_aeronefs()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare e record; v_nb integer; v_maj integer := 0; v_appareils text[];
begin
  for e in
    select * from public.evenements
     where statut = 'actif'
       and derniere_maj > now() - interval '6 hours'
       and not ('ADSB' = any(sources))
  loop
    select count(*), array_agg(distinct coalesce(o.indicatif, o.icao24))
      into v_nb, v_appareils
      from public.observations_aero o
     where o.vu_at > now() - interval '30 minutes'
       and st_dwithin(o.geom, e.centre, 4000);

    if v_nb >= 2 then
      update public.evenements
         set sources      = (select array_agg(distinct s) from unnest(sources || 'ADSB') s),
             derniere_maj = now(),
             fin_notifiee_at = null
       where id = e.id;

      -- La severite est recalculee : deux familles de sources concordantes.
      update public.evenements
         set severite = public.greatest_severite(severite, 'critique')
       where id = e.id;

      perform public.mettre_en_file_alertes(e.id);
      v_maj := v_maj + 1;
    end if;
  end loop;

  return jsonb_build_object('evenements_corrobores', v_maj);
end;
$$;

-- Purge courte : ces positions n'ont d'interet que dans l'heure.
create or replace function public.purger_aero()
returns integer
language sql security definer set search_path = public, extensions
as $$
  with p as (
    delete from public.observations_aero where vu_at < now() - interval '24 hours'
    returning 1)
  select count(*)::integer from p;
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
revoke all on all tables in schema public from anon, authenticated;
