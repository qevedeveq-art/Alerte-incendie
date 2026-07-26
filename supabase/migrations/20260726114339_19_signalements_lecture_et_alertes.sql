-- ===================================================================
--  Le message d'alerte doit dire d'ou vient l'information : un
--  signalement citoyen n'engage pas la meme confiance qu'une detection
--  satellite. On transmet donc l'origine dans le payload.
-- ===================================================================
create or replace function public.mettre_en_file_alertes(p_evt_id uuid)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  evt public.evenements; z public.zones;
  v_count integer := 0; r record;
  v_local time; v_silence boolean;
begin
  select * into evt from public.evenements where id = p_evt_id;
  if evt is null then return 0; end if;
  select * into z from public.zones where id = evt.zone_id;

  if evt.severite_notifiee is not null
     and public.severite_rang(evt.severite) <= public.severite_rang(evt.severite_notifiee) then
    return 0;
  end if;

  for r in
    select cx.id as canal_id, cx.type, ab.id as abonne_id, ab.seuil_min,
           ab.quiet_start, ab.quiet_end, ab.fuseau
      from public.zone_abonnes za
      join public.abonnes ab on ab.id = za.abonne_id and ab.actif
      join public.canaux  cx on cx.abonne_id = ab.id and cx.actif
     where za.zone_id = evt.zone_id
       and (cx.type <> 'email' or cx.verifie)
  loop
    if public.severite_rang(evt.severite) < public.severite_rang(r.seuil_min) then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'sous le seuil de l abonne')
      on conflict do nothing;
      continue;
    end if;

    v_silence := false;
    if r.quiet_start is not null and r.quiet_end is not null and evt.severite <> 'critique' then
      v_local := (now() at time zone r.fuseau)::time;
      v_silence := case when r.quiet_start <= r.quiet_end
                        then v_local between r.quiet_start and r.quiet_end
                        else v_local >= r.quiet_start or v_local <= r.quiet_end end;
    end if;

    if v_silence then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'heures silencieuses')
      on conflict do nothing;
      continue;
    end if;

    insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, payload)
    values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'en_attente',
            jsonb_build_object(
              'zone', z.nom, 'commune', coalesce(evt.commune_nom, z.nom),
              'dans_commune', evt.dans_commune, 'distance_m', evt.distance_m,
              'severite', evt.severite, 'nb_detections', evt.nb_detections,
              'frp_max', evt.frp_max, 'sources', evt.sources,
              'origine', evt.origine,
              'resolution_m', evt.resolution_min_m,
              'lat', st_y(evt.centre::geometry), 'lon', st_x(evt.centre::geometry),
              'debut_ts', evt.debut_ts, 'evenement_id', evt.id))
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  update public.evenements set severite_notifiee = evt.severite where id = p_evt_id;
  return v_count;
end;
$$;

-- ===================================================================
--  Lecture pour la carte : gris si non confirme, orange si confirme.
--  Non restreint aux zones de l'abonne : la carte est globale.
-- ===================================================================
create or replace function public.signalements_carte(p_heures integer default 24)
returns jsonb
language sql stable security definer set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id,
    'lat', st_y(g.centre::geometry),
    'lon', st_x(g.centre::geometry),
    'nb', g.nb,
    'nb_personnes', g.nb_personnes,
    'confirme', g.confirme,
    'natures', g.natures,
    'commune', g.commune_nom,
    'premier_at', g.premier_at,
    'dernier_at', g.dernier_at,
    'lie_evenement', g.evenement_id is not null
  ) order by g.dernier_at desc), '[]'::jsonb)
  from public.signalement_groupes g
  where g.statut = 'actif'
    and g.dernier_at > now() - make_interval(hours => p_heures);
$$;

-- L'origine remonte aussi dans l'historique affiche par la PWA
create or replace function public.evenements_abonne(p_abonne uuid, p_jours integer default 30)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(x order by x->>'debut_ts' desc), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', e.id, 'zone_id', e.zone_id, 'zone', z.nom,
      'statut', e.statut, 'severite', e.severite, 'origine', e.origine,
      'commune', e.commune_nom, 'dans_commune', e.dans_commune,
      'distance_m', e.distance_m, 'nb_detections', e.nb_detections,
      'frp_max', e.frp_max, 'sources', e.sources,
      'resolution_m', e.resolution_min_m,
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

-- Cloture des groupes inactifs, une fois par heure
select cron.schedule('clore-signalements', '25 * * * *',
  $$select public.clore_signalements()$$);

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