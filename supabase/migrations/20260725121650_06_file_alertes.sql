-- ===================================================================
--  MISE EN FILE DES ALERTES
--  Une alerte par (evenement, canal, niveau de severite) -> pas de spam,
--  mais escalade possible info -> alerte -> critique.
--  Heures silencieuses respectees SAUF pour les alertes critiques.
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

  -- deja notifie a ce niveau (ou plus haut) ?
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
  loop
    -- filtre seuil de l'abonne
    if public.severite_rang(evt.severite) < public.severite_rang(r.seuil_min) then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'sous le seuil de l abonne')
      on conflict do nothing;
      continue;
    end if;

    -- heures silencieuses (jamais pour critique)
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
              'zone',          z.nom,
              'commune',       coalesce(evt.commune_nom, z.nom),
              'dans_commune',  evt.dans_commune,
              'distance_m',    evt.distance_m,
              'severite',      evt.severite,
              'nb_detections', evt.nb_detections,
              'frp_max',       evt.frp_max,
              'sources',       evt.sources,
              'lat',           st_y(evt.centre::geometry),
              'lon',           st_x(evt.centre::geometry),
              'debut_ts',      evt.debut_ts,
              'evenement_id',  evt.id))
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  update public.evenements set severite_notifiee = evt.severite where id = p_evt_id;
  return v_count;
end;
$$;

-- Vue pratique : etat de sante du systeme
create or replace view public.v_sante
with (security_invoker = true) as
select
  (select max(finished_at) from public.runs where kind = 'poll-firms' and ok) as dernier_poll_ok,
  (select extract(epoch from now() - max(finished_at))::int / 60
     from public.runs where kind = 'poll-firms' and ok)                        as minutes_depuis_poll,
  (select count(*) from public.detections where acq_ts > now() - interval '24 hours' and not permanente) as detections_24h,
  (select count(*) from public.evenements where statut = 'actif')             as evenements_actifs,
  (select count(*) from public.alertes where statut = 'en_attente')           as alertes_en_attente,
  (select count(*) from public.alertes where statut = 'echec' and created_at > now() - interval '24 hours') as echecs_24h,
  (select count(*) from public.zones where actif)                            as zones_actives,
  (select count(*) from public.canaux where actif and verifie)               as canaux_operationnels,
  (select count(*) from public.sources_permanentes where confirmee)          as sources_permanentes;;