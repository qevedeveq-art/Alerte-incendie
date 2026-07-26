-- ===================================================================
--  SEVERITE TENANT COMPTE DE LA RESOLUTION
-- ---------------------------------------------------------------------
--  Les regles avaient ete calibrees pour VIIRS (375 m). L'arrivee du
--  geostationnaire (3 km, soit ~12,7 km2 par pixel) les rend fausses :
--  une seule detection MSG dans une commune de 19 km2 declenchait un
--  'critique', alors que le pixel couvre les deux tiers du territoire
--  communal et ne localise donc rien.
--
--  Correction : le raccourci "dans la commune" vers 'critique' exige
--  desormais une resolution fine (<= 1 km). Une detection grossiere
--  isolee plafonne a 'alerte'. Une FRP elevee (>= 50 MW) ou deux
--  familles de capteurs concordantes restent 'critique' quelle que
--  soit la resolution : ce sont des preuves independantes de la finesse.
-- ===================================================================
alter table public.evenements
  add column if not exists resolution_min_m integer;

comment on column public.evenements.resolution_min_m is
  'Resolution la plus fine parmi les detections de l''evenement, en metres. Sert a ponderer la confiance accordee a la localisation.';

create or replace function public.calc_severite(
  p_sensibilite text, p_nb integer, p_frp_max numeric,
  p_conf_max integer, p_dans_commune boolean, p_nb_sources integer,
  p_resolution_m integer default 375
) returns text
language sql immutable
set search_path = ''
as $$
  select case p_sensibilite

    when 'sensible' then
      case when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 or p_nb_sources >= 2
                or (p_dans_commune and coalesce(p_conf_max,0) >= 50 and coalesce(p_resolution_m,375) <= 1000)
             then 'critique'
           else 'alerte' end

    when 'conservateur' then
      case when p_nb >= 4 or coalesce(p_frp_max,0) >= 100 or p_nb_sources >= 2 then 'critique'
           when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 then 'alerte'
           else 'info' end

    else -- equilibre
      case when p_nb >= 3
                or coalesce(p_frp_max,0) >= 50
                or p_nb_sources >= 2
                or (p_dans_commune and coalesce(p_conf_max,0) >= 50
                    and coalesce(p_frp_max,0) >= 10
                    and coalesce(p_resolution_m,375) <= 1000)
             then 'critique'
           when coalesce(p_conf_max,0) >= 50 then 'alerte'
           else 'info' end
  end;
$$;

drop function if exists public.calc_severite(text,integer,numeric,integer,boolean,integer);

-- traiter_detections : suit la resolution la plus fine et la transmet
create or replace function public.traiter_detections()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  d record; z record; evt public.evenements;
  v_nouv integer := 0; v_maj integer := 0; v_rattach integer := 0;
  v_dans boolean; v_dist integer; v_com record; v_sev text;
begin
  for d in
    select dt.* from public.detections dt
    where not dt.permanente
      and dt.ingested_at > now() - interval '2 hours'
      and not exists (select 1 from public.evenement_detections ed where ed.detection_id = dt.id)
    order by dt.acq_ts
  loop
    for z in
      select * from public.zones
      where actif and geom is not null and st_intersects(geom, d.geom)
    loop
      select c.code, c.nom into v_com
        from public.communes c where st_intersects(c.geom, d.geom) limit 1;

      v_dans := (v_com.code is not null and v_com.code = z.commune_code);
      select round(st_distance(d.geom, c.centre))::integer into v_dist
        from public.communes c where c.code = z.commune_code;

      select * into evt from public.evenements e
       where e.zone_id = z.id and e.statut = 'actif'
         and e.derniere_maj > now() - interval '12 hours'
         and st_dwithin(e.centre, d.geom, 2000)
       order by st_distance(e.centre, d.geom) limit 1;

      if evt.id is null then
        insert into public.evenements (
          zone_id, severite, centre, nb_detections, frp_max, frp_total, sources,
          commune_code, commune_nom, dans_commune, distance_m, debut_ts, resolution_min_m)
        values (z.id, 'info', d.geom, 1, d.frp, coalesce(d.frp,0), array[d.source],
                v_com.code, v_com.nom, v_dans, v_dist, d.acq_ts, d.resolution_m)
        returning * into evt;
        v_nouv := v_nouv + 1;
      else
        update public.evenements e
           set nb_detections    = e.nb_detections + 1,
               frp_max          = greatest(coalesce(e.frp_max, 0), coalesce(d.frp, 0)),
               frp_total        = coalesce(e.frp_total, 0) + coalesce(d.frp, 0),
               sources          = (select array_agg(distinct s) from unnest(e.sources || d.source) s),
               centre           = st_centroid(st_collect(e.centre::geometry, d.geom::geometry))::geography,
               dans_commune     = e.dans_commune or v_dans,
               distance_m       = least(e.distance_m, v_dist),
               commune_code     = coalesce(e.commune_code, v_com.code),
               commune_nom      = coalesce(e.commune_nom, v_com.nom),
               resolution_min_m = least(coalesce(e.resolution_min_m, 999999), coalesce(d.resolution_m, 999999)),
               derniere_maj     = now()
         where e.id = evt.id
        returning * into evt;
        v_maj := v_maj + 1;
      end if;

      insert into public.evenement_detections values (evt.id, d.id) on conflict do nothing;
      v_rattach := v_rattach + 1;

      select public.calc_severite(
               z.sensibilite, evt.nb_detections, evt.frp_max,
               (select max(coalesce(x.confiance_num,0)) from public.detections x
                  join public.evenement_detections ed on ed.detection_id = x.id
                 where ed.evenement_id = evt.id),
               evt.dans_commune, array_length(evt.sources, 1), evt.resolution_min_m)
        into v_sev;

      if public.severite_rang(v_sev) > public.severite_rang(evt.severite) then
        update public.evenements set severite = v_sev where id = evt.id;
        evt.severite := v_sev;
      end if;

      perform public.mettre_en_file_alertes(evt.id);
    end loop;
  end loop;

  update public.evenements
     set statut = 'clos', clos_at = now()
   where statut = 'actif' and derniere_maj < now() - interval '18 hours';

  return jsonb_build_object('nouveaux', v_nouv, 'mis_a_jour', v_maj, 'rattachements', v_rattach);
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
revoke all on all tables in schema public from anon, authenticated;;