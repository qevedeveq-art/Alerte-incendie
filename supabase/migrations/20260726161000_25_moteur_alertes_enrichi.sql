-- ===================================================================
--  MOTEUR D'ALERTES ENRICHI
-- ---------------------------------------------------------------------
--  Rassemble en une seule reecriture de mettre_en_file_alertes tout ce
--  qui doit entrer dans le payload, plutot que d'empiler trois
--  migrations qui reecrivent la meme fonction :
--
--    - distance personnelle (point de reference de l'abonne)
--    - meteo au moment de l'alerte (vent, direction, risque)
--    - plafond par zone et par heure, jamais applique au critique
--
--  traiter_detections passe a la sensibilite effective (durcie par la
--  meteo), et une alerte de fin d'evenement est introduite : jusqu'ici
--  un evenement se cloturait en silence apres 18 h, laissant l'abonne
--  sur la derniere alerte recue sans jamais savoir que c'etait fini.
-- ===================================================================

alter table public.evenements
  add column if not exists fin_notifiee_at timestamptz;

-- ---------------------------------------------------------------------
--  Payload commun a l'alerte et a sa fin.
-- ---------------------------------------------------------------------
create or replace function public.payload_evenement(p_evt_id uuid, p_abonne uuid)
returns jsonb
language plpgsql stable security definer set search_path = public, extensions
as $$
declare
  evt public.evenements; z public.zones; m public.meteo;
  v_dist_perso integer; v_ref text;
begin
  select * into evt from public.evenements where id = p_evt_id;
  if evt is null then return null; end if;
  select * into z from public.zones  where id = evt.zone_id;
  select * into m from public.meteo  where zone_id = evt.zone_id;

  -- Distance a chez l'abonne : la seule qui l'interesse vraiment.
  select round(st_distance(a.ref_geom, evt.centre))::integer, a.ref_libelle
    into v_dist_perso, v_ref
    from public.abonnes a
   where a.id = p_abonne and a.ref_geom is not null;

  return jsonb_build_object(
    'zone', z.nom,
    'commune', coalesce(evt.commune_nom, z.nom),
    'dans_commune', evt.dans_commune,
    'distance_m', evt.distance_m,
    'distance_perso_m', v_dist_perso,
    'ref_libelle', v_ref,
    'severite', evt.severite,
    'nb_detections', evt.nb_detections,
    'nb_signalements', evt.nb_signalements,
    'frp_max', evt.frp_max,
    'sources', evt.sources,
    'origine', evt.origine,
    'resolution_m', evt.resolution_min_m,
    'lat', st_y(evt.centre::geometry),
    'lon', st_x(evt.centre::geometry),
    'debut_ts', evt.debut_ts,
    'derniere_maj', evt.derniere_maj,
    'evenement_id', evt.id,
    'meteo', case when m.zone_id is null or m.mesure_at < now() - interval '6 hours'
                  then null
                  else jsonb_build_object(
                    'vent_kmh', m.vent_kmh, 'rafales_kmh', m.rafales_kmh,
                    'vent_deg', m.vent_deg, 'temp_c', m.temp_c,
                    'humidite_pct', m.humidite_pct, 'risque', m.risque)
             end);
end;
$$;

-- ---------------------------------------------------------------------
--  Mise en file : seuil, heures silencieuses, plafond, payload enrichi.
-- ---------------------------------------------------------------------
create or replace function public.mettre_en_file_alertes(p_evt_id uuid)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  evt public.evenements;
  v_count integer := 0; r record;
  v_local time; v_silence boolean;
begin
  select * into evt from public.evenements where id = p_evt_id;
  if evt is null then return 0; end if;

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

    if public.plafond_atteint(r.abonne_id, evt.zone_id, evt.severite) then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'plafond horaire de la zone')
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
            public.payload_evenement(p_evt_id, r.abonne_id))
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  update public.evenements set severite_notifiee = evt.severite where id = p_evt_id;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
--  Fin d'alerte.
--  Un evenement sans nouvelle detection depuis 3 h est considere comme
--  eteint, du point de vue de l'abonne. On ne le clot pas encore (la
--  cloture reste a 18 h, pour qu'une reprise se rattache au meme
--  evenement), mais on previent : sans cela, la derniere information
--  recue reste une alerte incendie, indefiniment.
--  Uniquement vers ceux qui ont recu l'alerte initiale.
-- ---------------------------------------------------------------------
create or replace function public.notifier_fin_evenements()
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare e record; r record; v_count integer := 0;
begin
  for e in
    select * from public.evenements
     where statut = 'actif'
       and severite_notifiee is not null
       and fin_notifiee_at is null
       and derniere_maj < now() - interval '3 hours'
  loop
    for r in
      select distinct a.canal_id, a.abonne_id
        from public.alertes a
        join public.canaux cx on cx.id = a.canal_id and cx.actif
       where a.evenement_id = e.id
         and a.type = 'alerte'
         and a.statut = 'envoye'
    loop
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, payload)
      values (e.id, r.canal_id, r.abonne_id, 'fin', e.severite, 'en_attente',
              public.payload_evenement(e.id, r.abonne_id))
      on conflict do nothing;
      v_count := v_count + 1;
    end loop;
    update public.evenements set fin_notifiee_at = now() where id = e.id;
  end loop;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
--  traiter_detections : sensibilite effective (durcie par la meteo).
-- ---------------------------------------------------------------------
create or replace function public.traiter_detections()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  d record; z record; evt public.evenements;
  v_nouv integer := 0; v_maj integer := 0; v_rattach integer := 0;
  v_dans boolean; v_dist integer; v_com record; v_sev text; v_sens text;
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
               derniere_maj     = now(),
               -- une reprise annule la fin d'alerte deja notifiee
               fin_notifiee_at  = null
         where e.id = evt.id
        returning * into evt;
        v_maj := v_maj + 1;
      end if;

      insert into public.evenement_detections values (evt.id, d.id) on conflict do nothing;
      v_rattach := v_rattach + 1;

      v_sens := public.sensibilite_effective(z.id);

      select public.calc_severite(
               v_sens, evt.nb_detections, evt.frp_max,
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

  perform public.notifier_fin_evenements();

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
revoke all on all tables in schema public from anon, authenticated;
