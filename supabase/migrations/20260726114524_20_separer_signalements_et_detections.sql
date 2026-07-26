-- ===================================================================
--  SEPARATION DES UNITES DE PREUVE
-- ---------------------------------------------------------------------
--  nb_detections melangeait pixels satellite et signalements citoyens.
--  La regle "3 detections -> critique" pouvait donc etre atteinte par
--  trois signalements humains seuls, ce qui contredit la hierarchie des
--  preuves voulue. Deux compteurs distincts, deux roles distincts :
--
--    nb_detections   pixels satellite, alimente calc_severite
--    nb_signalements signalements citoyens, informatif et affiche
--
--  La corroboration inter-sources reste assuree par le tableau sources
--  qui contient 'CITOYEN' : un signalement confirme plus un pixel
--  satellite donne nb_sources >= 2, donc 'critique'. C'est le cas le
--  plus fiable et c'est bien celui qu'on veut privilegier.
-- ===================================================================
alter table public.evenements
  add column if not exists nb_signalements integer not null default 0;

comment on column public.evenements.nb_detections is
  'Pixels satellite rattaches. Seul compteur utilise par calc_severite.';
comment on column public.evenements.nb_signalements is
  'Signalements citoyens rattaches. Informatif, jamais utilise pour elever la severite seul.';

-- Reprise des evenements existants nes d'un signalement
update public.evenements e
   set nb_signalements = e.nb_detections, nb_detections = 0
 where e.origine = 'citoyen'
   and not exists (select 1 from public.evenement_detections ed where ed.evenement_id = e.id);

create or replace function public.promouvoir_signalement(p_groupe uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare
  g public.signalement_groupes; z record; evt public.evenements;
  v_dist integer; v_dans boolean; v_id uuid;
begin
  select * into g from public.signalement_groupes where id = p_groupe;
  if g is null or not g.confirme then return null; end if;
  if g.evenement_id is not null then return g.evenement_id; end if;

  for z in
    select * from public.zones
    where actif and geom is not null and st_intersects(geom, g.centre)
  loop
    v_dans := (g.commune_code is not null and g.commune_code = z.commune_code);
    select round(st_distance(g.centre, c.centre))::integer into v_dist
      from public.communes c where c.code = z.commune_code;

    select * into evt from public.evenements e
     where e.zone_id = z.id and e.statut = 'actif'
       and e.derniere_maj > now() - interval '12 hours'
       and st_dwithin(e.centre, g.centre, 2000)
     order by st_distance(e.centre, g.centre) limit 1;

    if evt.id is null then
      -- Signalements seuls : severite plafonnee a 'alerte', nb_detections a 0.
      insert into public.evenements (
        zone_id, origine, severite, centre, nb_detections, nb_signalements, sources,
        commune_code, commune_nom, dans_commune, distance_m, debut_ts, resolution_min_m)
      values (z.id, 'citoyen', 'alerte', g.centre, 0, g.nb, array['CITOYEN'],
              g.commune_code, g.commune_nom, coalesce(v_dans, false), v_dist,
              g.premier_at, 50)
      returning * into evt;
    else
      -- Le satellite avait deja vu : terrain et espace concordent.
      update public.evenements e
         set origine = 'mixte',
             sources = (select array_agg(distinct s) from unnest(e.sources || 'CITOYEN') s),
             nb_signalements = e.nb_signalements + g.nb,
             severite = greatest_severite(e.severite, 'critique'),
             derniere_maj = now()
       where e.id = evt.id
      returning * into evt;
    end if;

    update public.signalement_groupes set evenement_id = evt.id where id = g.id;
    v_id := evt.id;
    perform public.mettre_en_file_alertes(evt.id);
  end loop;

  return v_id;
end;
$$;

-- Petit utilitaire : garde la severite la plus elevee des deux
create or replace function public.greatest_severite(a text, b text)
returns text language sql immutable set search_path = '' as $$
  select case when case a when 'critique' then 3 when 'alerte' then 2 when 'info' then 1 else 0 end
              >= case b when 'critique' then 3 when 'alerte' then 2 when 'info' then 1 else 0 end
              then a else b end;
$$;

-- traiter_detections : un pixel satellite qui rejoint un evenement citoyen
-- le fait basculer en 'mixte'.
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
          zone_id, origine, severite, centre, nb_detections, frp_max, frp_total, sources,
          commune_code, commune_nom, dans_commune, distance_m, debut_ts, resolution_min_m)
        values (z.id, 'satellite', 'info', d.geom, 1, d.frp, coalesce(d.frp,0), array[d.source],
                v_com.code, v_com.nom, v_dans, v_dist, d.acq_ts, d.resolution_m)
        returning * into evt;
        v_nouv := v_nouv + 1;
      else
        update public.evenements e
           set nb_detections    = e.nb_detections + 1,
               origine          = case when e.origine = 'citoyen' then 'mixte' else e.origine end,
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