-- ===================================================================
--  METEO, POINT DE REFERENCE ABONNE, PLAFOND D'ALERTES
-- ---------------------------------------------------------------------
--  Trois ajouts qui n'ont rien en commun techniquement mais tous le
--  meme objectif : rendre l'alerte utilisable par celui qui la recoit.
--
--  1. Meteo (Open-Meteo, gratuit, sans cle, heberge en UE).
--     Le vent est l'information manquante : « feu a 4 km » ne dit pas
--     s'il vient vers vous. Il sert aussi a moduler la sensibilite.
--
--  2. Point de reference par abonne. Aujourd'hui la distance affichee
--     part du centre de la commune ; ce qui compte pour un abonne est
--     la distance a chez lui.
--
--  3. Plafond d'alertes. Un feu a large front produit plusieurs
--     evenements (grappe de 2 km) donc plusieurs alertes par abonne.
-- ===================================================================

-- ---------------------------------------------------------------------
--  1. METEO
-- ---------------------------------------------------------------------
create table if not exists public.meteo (
  zone_id      uuid primary key references public.zones(id) on delete cascade,
  mesure_at    timestamptz not null,
  temp_c       numeric,
  humidite_pct numeric,
  vent_kmh     numeric,
  rafales_kmh  numeric,
  vent_deg     numeric,
  risque       text not null default 'inconnu'
                 check (risque in ('inconnu','faible','modere','eleve','tres_eleve')),
  score        smallint not null default 0,
  updated_at   timestamptz not null default now()
);
alter table public.meteo enable row level security;

comment on table public.meteo is
  'Derniere observation meteo par zone (Open-Meteo). Sert a enrichir les alertes et a moduler la sensibilite.';

-- Indice de risque : proxy local, PAS l'IFM de Meteo-France ni le FWI
-- europeen. Il combine les trois variables qui pilotent reellement la
-- propagation d'un feu de vegetation : air sec, vent, chaleur.
create or replace function public.calc_risque_meteo(
  p_temp numeric, p_humidite numeric, p_vent numeric, p_rafales numeric
) returns table (risque text, score smallint)
language sql immutable
set search_path = ''
as $$
  with s as (
    select (
      case when p_humidite is null then 0
           when p_humidite < 30 then 2
           when p_humidite < 45 then 1
           else 0 end
    + case when coalesce(p_rafales, p_vent) is null then 0
           when coalesce(p_rafales, p_vent) >= 60 then 3
           when coalesce(p_rafales, p_vent) >= 40 then 2
           when coalesce(p_rafales, p_vent) >= 25 then 1
           else 0 end
    + case when p_temp is null then 0
           when p_temp >= 34 then 2
           when p_temp >= 29 then 1
           else 0 end
    )::smallint as n
  )
  select case when n >= 6 then 'tres_eleve'
              when n >= 4 then 'eleve'
              when n >= 2 then 'modere'
              else 'faible' end, n
    from s;
$$;

-- Points d'interrogation meteo : un par zone active, au centre de la
-- commune principale. Inutile d'interroger plus finement, les variables
-- concernees varient peu a l'echelle d'une intercommunalite.
create or replace function public.zones_a_meteo()
returns table (zone_id uuid, lat double precision, lon double precision)
language sql stable security definer set search_path = public, extensions
as $$
  select z.id, st_y(c.centre::geometry), st_x(c.centre::geometry)
    from public.zones z
    join public.communes c on c.code = z.commune_code
   where z.actif;
$$;

-- Enregistre une observation et recalcule le risque.
create or replace function public.maj_meteo(
  p_zone uuid, p_mesure_at timestamptz, p_temp numeric, p_humidite numeric,
  p_vent numeric, p_rafales numeric, p_deg numeric
) returns text
language plpgsql security definer set search_path = public, extensions
as $$
declare v_risque text; v_score smallint;
begin
  select r.risque, r.score into v_risque, v_score
    from public.calc_risque_meteo(p_temp, p_humidite, p_vent, p_rafales) r;

  insert into public.meteo (zone_id, mesure_at, temp_c, humidite_pct,
                            vent_kmh, rafales_kmh, vent_deg, risque, score, updated_at)
  values (p_zone, p_mesure_at, p_temp, p_humidite, p_vent, p_rafales, p_deg,
          v_risque, v_score, now())
  on conflict (zone_id) do update
     set mesure_at = excluded.mesure_at, temp_c = excluded.temp_c,
         humidite_pct = excluded.humidite_pct, vent_kmh = excluded.vent_kmh,
         rafales_kmh = excluded.rafales_kmh, vent_deg = excluded.vent_deg,
         risque = excluded.risque, score = excluded.score, updated_at = now();
  return v_risque;
end;
$$;

-- Sensibilite reellement appliquee = sensibilite choisie, eventuellement
-- durcie par la meteo. La modulation est volontairement ASYMETRIQUE :
-- elle ne peut que rendre le systeme plus sensible, jamais moins. Un
-- assouplissement automatique par beau temps reviendrait a masquer un
-- depart de feu sur la foi d'une prevision, ce qu'on refuse.
create or replace function public.sensibilite_effective(p_zone_id uuid)
returns text
language sql stable security definer set search_path = public, extensions
as $$
  select case
    when m.risque in ('eleve','tres_eleve') and m.mesure_at > now() - interval '6 hours'
      then case z.sensibilite when 'conservateur' then 'equilibre'
                              when 'equilibre'    then 'sensible'
                              else z.sensibilite end
    else z.sensibilite
  end
  from public.zones z
  left join public.meteo m on m.zone_id = z.id
  where z.id = p_zone_id;
$$;

-- ---------------------------------------------------------------------
--  2. POINT DE REFERENCE DE L'ABONNE
-- ---------------------------------------------------------------------
alter table public.abonnes
  add column if not exists ref_geom    geography(Point, 4326),
  add column if not exists ref_libelle text;

comment on column public.abonnes.ref_geom is
  'Point de reference facultatif (domicile, exploitation). Sert a calculer une distance personnelle dans l''alerte. Jamais expose a un autre abonne.';

-- Ecriture depuis la PWA. Passer lat null efface le point de reference.
create or replace function public.maj_reference(
  p_abonne uuid, p_lat double precision, p_lon double precision, p_libelle text
) returns boolean
language plpgsql security definer set search_path = public, extensions
as $$
begin
  if p_lat is null or p_lon is null then
    update public.abonnes set ref_geom = null, ref_libelle = null where id = p_abonne;
    return false;
  end if;
  if p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    raise exception 'coordonnees hors bornes';
  end if;
  update public.abonnes
     set ref_geom    = st_setsrid(st_makepoint(p_lon, p_lat), 4326)::geography,
         ref_libelle = nullif(left(coalesce(p_libelle, ''), 40), '')
   where id = p_abonne;
  return true;
end;
$$;

-- Meteo des zones auxquelles l'abonne est rattache, pour l'affichage PWA.
create or replace function public.meteo_abonne(p_abonne uuid)
returns jsonb
language sql stable security definer set search_path = public, extensions
as $$
  select coalesce(jsonb_object_agg(m.zone_id, jsonb_build_object(
    'mesure_at', m.mesure_at, 'temp_c', m.temp_c, 'humidite_pct', m.humidite_pct,
    'vent_kmh', m.vent_kmh, 'rafales_kmh', m.rafales_kmh, 'vent_deg', m.vent_deg,
    'risque', m.risque, 'score', m.score)), '{}'::jsonb)
  from public.meteo m
  join public.zone_abonnes za on za.zone_id = m.zone_id
 where za.abonne_id = p_abonne;
$$;

-- ---------------------------------------------------------------------
--  3. PLAFOND D'ALERTES
-- ---------------------------------------------------------------------
alter table public.zones
  add column if not exists max_alertes_h smallint not null default 4
    check (max_alertes_h between 1 and 50);

comment on column public.zones.max_alertes_h is
  'Nombre maximal d''alertes non critiques par abonne et par heure sur cette zone. Les alertes critiques ne sont jamais plafonnees.';

-- Le plafond ne s'applique jamais a 'critique' : silencer une alerte
-- critique pour cause de volume serait exactement la panne que ce
-- systeme est cense eviter.
create or replace function public.plafond_atteint(
  p_abonne uuid, p_zone uuid, p_severite text
) returns boolean
language sql stable security definer set search_path = public, extensions
as $$
  select case when p_severite = 'critique' then false else
    (select count(*) from public.alertes a
       join public.evenements e on e.id = a.evenement_id
      where a.abonne_id = p_abonne
        and e.zone_id   = p_zone
        and a.type      = 'alerte'
        and a.statut in ('en_attente','envoye')
        and a.created_at > now() - interval '1 hour')
    >= coalesce((select max_alertes_h from public.zones where id = p_zone), 4)
  end;
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
