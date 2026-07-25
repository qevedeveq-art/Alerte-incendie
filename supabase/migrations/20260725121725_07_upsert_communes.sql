-- Insertion en lot des contours communaux, simplifies a ~56 m cote Postgres
create or replace function public.upsert_communes(p_data jsonb)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare n integer;
begin
  insert into public.communes (code, nom, departement, population, surface_ha, centre, geom)
  select e->>'code',
         e->>'nom',
         e->>'departement',
         nullif(e->>'population','')::integer,
         nullif(e->>'surface_ha','')::numeric,
         case when e->'centre' is not null and e->'centre' <> 'null'::jsonb
              then st_geomfromgeojson(e->'centre')::geography end,
         st_multi(
           st_makevalid(
             st_simplifypreservetopology(
               st_geomfromgeojson(e->'contour'), 0.0005)))::geography
  from jsonb_array_elements(p_data) e
  on conflict (code) do update
    set nom = excluded.nom,
        departement = excluded.departement,
        population = excluded.population,
        surface_ha = excluded.surface_ha,
        centre = excluded.centre,
        geom = excluded.geom,
        loaded_at = now();
  get diagnostics n = row_count;
  return n;
end;
$$;;