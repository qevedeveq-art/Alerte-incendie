-- Lectures dediees a la PWA : GeoJSON pret a afficher, filtre sur l'abonne.
create or replace function public.zones_abonne(p_abonne uuid)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', z.id, 'nom', z.nom, 'commune_code', z.commune_code,
    'sensibilite', z.sensibilite, 'buffer_m', z.buffer_m,
    'inclure_limitrophes', z.inclure_limitrophes,
    'limitrophes', (select coalesce(jsonb_agg(c2.nom order by c2.nom), '[]'::jsonb)
                     from public.communes c2 where c2.code = any(z.limitrophes)),
    'surface_km2', round((st_area(z.geom)/1e6)::numeric, 1),
    'centre', jsonb_build_array(st_y(c.centre::geometry), st_x(c.centre::geometry)),
    'geojson', st_asgeojson(st_simplifypreservetopology(z.geom::geometry, 0.0008))::jsonb
  ) order by z.nom), '[]'::jsonb)
  from public.zone_abonnes za
  join public.zones z on z.id = za.zone_id and z.actif
  join public.communes c on c.code = z.commune_code
  where za.abonne_id = p_abonne;
$$;

create or replace function public.evenements_abonne(p_abonne uuid, p_jours integer default 30)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(x order by x->>'debut_ts' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', e.id, 'zone_id', e.zone_id, 'zone', z.nom,
      'statut', e.statut, 'severite', e.severite,
      'commune', e.commune_nom, 'dans_commune', e.dans_commune,
      'distance_m', e.distance_m, 'nb_detections', e.nb_detections,
      'frp_max', e.frp_max, 'sources', e.sources,
      'lat', st_y(e.centre::geometry), 'lon', st_x(e.centre::geometry),
      'debut_ts', e.debut_ts, 'derniere_maj', e.derniere_maj,
      'notifiee', e.severite_notifiee is not null
    ) as x
    from public.zone_abonnes za
    join public.evenements e on e.zone_id = za.zone_id
    join public.zones z on z.id = e.zone_id
    where za.abonne_id = p_abonne
      and e.debut_ts > now() - make_interval(days => p_jours)
    order by e.debut_ts desc
    limit 200
  ) s;
$$;

create or replace function public.detections_abonne(p_abonne uuid, p_heures integer default 72)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'lat', d.lat, 'lon', d.lon, 'source', d.source, 'acq_ts', d.acq_ts,
    'frp', d.frp, 'confiance', d.confiance, 'permanente', d.permanente
  )), '[]'::jsonb)
  from public.detections d
  where d.acq_ts > now() - make_interval(hours => p_heures)
    and exists (
      select 1 from public.zone_abonnes za
      join public.zones z on z.id = za.zone_id and z.actif
      where za.abonne_id = p_abonne and st_intersects(z.geom, d.geom));
$$;

revoke all on function public.zones_abonne(uuid)              from anon, authenticated;
revoke all on function public.evenements_abonne(uuid,integer)  from anon, authenticated;
revoke all on function public.detections_abonne(uuid,integer)  from anon, authenticated;
revoke all on function public.upsert_zone(text,boolean,integer,text) from anon, authenticated;
revoke all on function public.refresh_zone_geom(uuid)          from anon, authenticated;
revoke all on function public.upsert_communes(jsonb)           from anon, authenticated;
revoke all on function public.traiter_detections()             from anon, authenticated;
revoke all on function public.bbox_surveillance(numeric)       from anon, authenticated;;