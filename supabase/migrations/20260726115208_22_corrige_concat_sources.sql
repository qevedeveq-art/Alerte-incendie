-- ===================================================================
--  CORRECTIF : concatenation du tableau sources
-- ---------------------------------------------------------------------
--  e.sources || 'CITOYEN' echouait : le litteral n'etant pas type,
--  Postgres le resolvait en text[] et rejetait « malformed array
--  literal ». Le chemin concerne est celui ou le satellite a detecte le
--  feu AVANT que des temoins ne le confirment — realiste, et jamais
--  exerce jusqu'ici car le scenario teste allait dans l'autre sens.
-- ===================================================================
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
      values (z.id, 'citoyen', 'alerte', g.centre, 0, g.nb, array['CITOYEN']::text[],
              g.commune_code, g.commune_nom, coalesce(v_dans, false), v_dist,
              g.premier_at, 50)
      returning * into evt;
    else
      -- Le satellite avait deja vu : terrain et espace concordent, c'est le
      -- niveau de fiabilite le plus eleve du systeme.
      update public.evenements e
         set origine = 'mixte',
             sources = (select array_agg(distinct s)
                          from unnest(e.sources || array['CITOYEN']::text[]) s),
             nb_signalements = e.nb_signalements + g.nb,
             severite = public.greatest_severite(e.severite, 'critique'),
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