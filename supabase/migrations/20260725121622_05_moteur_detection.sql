-- ===================================================================
--  APPRENTISSAGE DES SOURCES THERMIQUES PERMANENTES
--  Une cellule de ~500 m qui chauffe >= 8 jours differents etales sur
--  >= 30 jours est une source fixe (usine, torchere, four) et non un feu.
-- ===================================================================
create or replace function public.apprendre_sources_permanentes()
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare n integer;
begin
  insert into public.sources_permanentes (cell, geom, occurrences, jours_actifs, first_seen, last_seen)
  select cell,
         st_setsrid(st_point(avg(lon), avg(lat)), 4326)::geography,
         count(*),
         count(distinct acq_ts::date),
         min(acq_ts), max(acq_ts)
  from (
    select round(lat / 0.005) || '_' || round(lon / 0.005) as cell, lat, lon, acq_ts
    from public.detections
    where ingested_at > now() - interval '2 hours'
  ) s
  group by cell
  on conflict (cell) do update
    set occurrences  = public.sources_permanentes.occurrences + excluded.occurrences,
        jours_actifs = public.sources_permanentes.jours_actifs
                       + (case when excluded.last_seen::date > public.sources_permanentes.last_seen::date then 1 else 0 end),
        last_seen    = greatest(public.sources_permanentes.last_seen, excluded.last_seen);

  update public.sources_permanentes
     set confirmee = true
   where not confirmee
     and jours_actifs >= 8
     and last_seen - first_seen >= interval '30 days';

  update public.detections d
     set permanente = true
   from public.sources_permanentes sp
  where sp.confirmee
    and not d.permanente
    and d.ingested_at > now() - interval '2 hours'
    and st_dwithin(d.geom, sp.geom, 400);

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ===================================================================
--  CALCUL DE SEVERITE selon la sensibilite de la zone
-- ===================================================================
create or replace function public.calc_severite(
  p_sensibilite text, p_nb integer, p_frp_max numeric,
  p_conf_max integer, p_dans_commune boolean, p_nb_sources integer
) returns text
language sql immutable
as $$
  select case p_sensibilite

    when 'sensible' then
      case when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 or (p_dans_commune and coalesce(p_conf_max,0) >= 50)
             then 'critique'
           else 'alerte' end

    when 'conservateur' then
      case when p_nb >= 4 or coalesce(p_frp_max,0) >= 100 or p_nb_sources >= 2 then 'critique'
           when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 then 'alerte'
           else 'info' end

    else -- equilibre
      case when p_nb >= 3 or coalesce(p_frp_max,0) >= 50 or p_nb_sources >= 2
                or (p_dans_commune and coalesce(p_conf_max,0) >= 50 and coalesce(p_frp_max,0) >= 10)
             then 'critique'
           when coalesce(p_conf_max,0) >= 50 then 'alerte'
           else 'info' end
  end;
$$;

create or replace function public.severite_rang(s text)
returns integer language sql immutable as
$$ select case s when 'critique' then 3 when 'alerte' then 2 when 'info' then 1 else 0 end $$;

-- ===================================================================
--  CLUSTERING : rattache les nouvelles detections a des evenements
--  Rayon 2 km, fenetre 12 h. Un evenement = un feu.
-- ===================================================================
create or replace function public.traiter_detections()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  d record; z record; evt public.evenements;
  v_evt_id uuid; v_nouv integer := 0; v_maj integer := 0; v_rattach integer := 0;
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
      -- commune reellement touchee
      select c.code, c.nom into v_com
        from public.communes c
       where st_intersects(c.geom, d.geom)
       limit 1;

      v_dans := (v_com.code is not null and v_com.code = z.commune_code);
      select round(st_distance(d.geom, c.centre))::integer into v_dist
        from public.communes c where c.code = z.commune_code;

      -- evenement existant proche (2 km / 12 h) ?
      select * into evt from public.evenements e
       where e.zone_id = z.id and e.statut = 'actif'
         and e.derniere_maj > now() - interval '12 hours'
         and st_dwithin(e.centre, d.geom, 2000)
       order by st_distance(e.centre, d.geom)
       limit 1;

      if evt.id is null then
        insert into public.evenements (
          zone_id, severite, centre, nb_detections, frp_max, frp_total, sources,
          commune_code, commune_nom, dans_commune, distance_m, debut_ts)
        values (z.id, 'info', d.geom, 1, d.frp, coalesce(d.frp,0), array[d.source],
                v_com.code, v_com.nom, v_dans, v_dist, d.acq_ts)
        returning * into evt;
        v_nouv := v_nouv + 1;
      else
        update public.evenements e
           set nb_detections = e.nb_detections + 1,
               frp_max       = greatest(coalesce(e.frp_max, 0), coalesce(d.frp, 0)),
               frp_total     = coalesce(e.frp_total, 0) + coalesce(d.frp, 0),
               sources       = (select array_agg(distinct s) from unnest(e.sources || d.source) s),
               centre        = st_centroid(st_collect(e.centre::geometry, d.geom::geometry))::geography,
               dans_commune  = e.dans_commune or v_dans,
               distance_m    = least(e.distance_m, v_dist),
               commune_code  = coalesce(e.commune_code, v_com.code),
               commune_nom   = coalesce(e.commune_nom, v_com.nom),
               derniere_maj  = now()
         where e.id = evt.id
        returning * into evt;
        v_maj := v_maj + 1;
      end if;

      insert into public.evenement_detections values (evt.id, d.id) on conflict do nothing;
      v_rattach := v_rattach + 1;

      -- recalcul de severite sur l'ensemble des detections de l'evenement
      select public.calc_severite(
               z.sensibilite, evt.nb_detections, evt.frp_max,
               (select max(coalesce(x.confiance_num,0)) from public.detections x
                  join public.evenement_detections ed on ed.detection_id = x.id
                 where ed.evenement_id = evt.id),
               evt.dans_commune, array_length(evt.sources, 1))
        into v_sev;

      if public.severite_rang(v_sev) > public.severite_rang(evt.severite) then
        update public.evenements set severite = v_sev where id = evt.id;
        evt.severite := v_sev;
      end if;

      perform public.mettre_en_file_alertes(evt.id);
    end loop;
  end loop;

  -- cloture des evenements sans nouvelle detection depuis 18 h
  update public.evenements
     set statut = 'clos', clos_at = now()
   where statut = 'actif' and derniere_maj < now() - interval '18 hours';

  return jsonb_build_object('nouveaux', v_nouv, 'mis_a_jour', v_maj, 'rattachements', v_rattach);
end;
$$;;