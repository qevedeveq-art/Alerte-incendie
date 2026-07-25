-- Calcule les communes limitrophes et la geometrie de surveillance d'une zone.
-- Necessite que la commune ET ses voisines soient presentes dans public.communes.
create or replace function public.refresh_zone_geom(p_zone_id uuid)
returns public.zones
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  z public.zones;
  g_base geometry;
  g_final geometry;
  lims text[];
begin
  select * into z from public.zones where id = p_zone_id;
  if z is null then raise exception 'zone % introuvable', p_zone_id; end if;

  select geom::geometry into g_base from public.communes where code = z.commune_code;
  if g_base is null then raise exception 'commune % absente du cache', z.commune_code; end if;

  if z.inclure_limitrophes then
    -- voisines = contours qui se touchent (tolerance 25 m pour absorber les imprecisions de simplification)
    select coalesce(array_agg(c.code order by c.nom), '{}')
      into lims
    from public.communes c
    where c.code <> z.commune_code
      and st_dwithin(c.geom, z_commune_geog(z.commune_code), 25);

    select st_union(array_append(
             array(select geom::geometry from public.communes where code = any(lims)),
             g_base))
      into g_final;
  else
    lims := '{}';
    g_final := g_base;
  end if;

  if z.buffer_m > 0 then
    -- buffer metrique via geography puis retour en geometry
    g_final := st_buffer(g_final::geography, z.buffer_m)::geometry;
  end if;

  update public.zones
     set limitrophes = lims,
         geom = st_multi(st_makevalid(g_final))::geography
   where id = p_zone_id
  returning * into z;

  return z;
end;
$$;

-- petit helper (evite un sous-select repete)
create or replace function public.z_commune_geog(p_code text)
returns geography
language sql stable
security definer
set search_path = public
as $$ select geom from public.communes where code = p_code $$;

-- Cree (ou met a jour) une zone a partir d'un code INSEE
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
  if c is null then raise exception 'commune % non chargee : appelez load-communes pour le departement', p_code; end if;

  insert into public.zones (nom, commune_code, inclure_limitrophes, buffer_m, sensibilite)
  values (c.nom, p_code, p_limitrophes, p_buffer_m, p_sensibilite)
  on conflict (commune_code, buffer_m, inclure_limitrophes)
    do update set sensibilite = excluded.sensibilite, actif = true
  returning * into z;

  return public.refresh_zone_geom(z.id);
end;
$$;;