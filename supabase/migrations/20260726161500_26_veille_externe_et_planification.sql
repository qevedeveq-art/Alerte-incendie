-- ===================================================================
--  VEILLE EXTERNE ET PLANIFICATION
-- ---------------------------------------------------------------------
--  1. Interrupteur d'homme mort externe.
--     Le heartbeat actuel vit dans le systeme qu'il surveille : pg_cron,
--     les Edge Functions et la base sont dans le meme projet Supabase.
--     Si le projet est en pause, sature, ou si pg_cron s'arrete, plus
--     rien ne previent personne — exactement la panne que le heartbeat
--     est cense attraper.
--
--     On inverse donc la logique : le systeme envoie un signal
--     PERIODIQUE VERS L'EXTERIEUR tant qu'il va bien. C'est l'absence
--     de signal qui declenche l'alerte, chez un tiers qui, lui, ne
--     depend pas de Supabase (healthchecks.io, cron-job.org, UptimeRobot).
--     Une panne totale devient donc detectable, ce qu'elle n'etait pas.
--
--  2. Autotest mensuel des canaux : un canal push revoque n'est
--     desactive qu'a l'usage. On le decouvrait le jour du feu.
--
--  3. Planification declarative. Les taches pg_cron n'existaient que
--     dans la base de production, creees a la main : une reconstruction
--     du projet depuis les migrations repartait sans aucune collecte.
-- ===================================================================

-- ---------------------------------------------------------------------
--  1. SIGNAL VERS L'EXTERIEUR
-- ---------------------------------------------------------------------
create or replace function public.ping_externe()
returns boolean
language plpgsql security definer set search_path = public, extensions
as $$
declare v_url text;
begin
  select v #>> '{}' into v_url from public.config where k = 'heartbeat_url';
  if v_url is null or v_url = '' then return false; end if;
  perform net.http_get(url := v_url, timeout_milliseconds := 10000);
  return true;
exception when others then
  -- Le ping ne doit jamais faire echouer le controle de sante lui-meme.
  return false;
end;
$$;

comment on function public.ping_externe() is
  'Signale a un service tiers que le systeme est vivant. L''absence de ping declenche l''alerte cote tiers.';

-- ---------------------------------------------------------------------
--  Controle de sante : signale la panne en interne, et confirme la
--  bonne sante en externe. Le ping n'est emis QUE si tout va bien.
-- ---------------------------------------------------------------------
create or replace function public.verifier_sante()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_min integer; v_dernier timestamptz;
  v_geo integer; v_geo_conf boolean;
  v_alertes integer := 0; r record;
  v_msg text; v_sev text; v_ping boolean := false;
begin
  select minutes_depuis_poll, dernier_poll_ok, minutes_depuis_geo, geo_configure
    into v_min, v_dernier, v_geo, v_geo_conf
  from public.v_sante;

  if v_min is null or v_min > 45 then
    v_sev := 'critique';
    v_msg := format(
      'Aucune collecte satellite reussie depuis %s minutes. Les alertes incendie sont peut-etre suspendues.',
      coalesce(v_min::text, 'un temps indetermine'));
  elsif v_geo_conf and (v_geo is null or v_geo > 60) then
    v_sev := 'alerte';
    v_msg := format(
      'Collecte geostationnaire interrompue depuis %s minutes. La surveillance continue via NASA FIRMS, mais avec 2 a 3 h de latence au lieu de 30 minutes.',
      coalesce(v_geo::text, 'un temps indetermine'));
  else
    -- Tout va bien : c'est le seul cas ou l'on rassure le veilleur externe.
    v_ping := public.ping_externe();
    return jsonb_build_object('minutes_depuis_poll', v_min, 'minutes_depuis_geo', v_geo,
                              'alertes_heartbeat', 0, 'ping_externe', v_ping);
  end if;

  if exists (select 1 from public.alertes
             where type = 'heartbeat' and created_at > now() - interval '6 hours') then
    return jsonb_build_object('minutes_depuis_poll', v_min, 'minutes_depuis_geo', v_geo,
                              'alertes_heartbeat', 0, 'note', 'deja signale recemment');
  end if;

  for r in
    select cx.id as canal_id, ab.id as abonne_id
    from public.canaux cx
    join public.abonnes ab on ab.id = cx.abonne_id and ab.actif
    where cx.actif and (cx.type <> 'email' or cx.verifie)
  loop
    insert into public.alertes (canal_id, abonne_id, type, severite, statut, payload)
    values (r.canal_id, r.abonne_id, 'heartbeat', v_sev, 'en_attente',
            jsonb_build_object(
              'zone', 'Systeme', 'commune', 'Surveillance degradee',
              'dans_commune', true, 'distance_m', 0, 'severite', v_sev,
              'nb_detections', 0, 'frp_max', null, 'sources', array['systeme'],
              'lat', 0, 'lon', 0,
              'debut_ts', coalesce(v_dernier, now()),
              'evenement_id', 'heartbeat',
              'message', v_msg));
    v_alertes := v_alertes + 1;
  end loop;

  return jsonb_build_object('minutes_depuis_poll', v_min, 'minutes_depuis_geo', v_geo,
                            'severite', v_sev, 'alertes_heartbeat', v_alertes);
end;
$$;

-- ---------------------------------------------------------------------
--  2. AUTOTEST MENSUEL DES CANAUX
-- ---------------------------------------------------------------------
create or replace function public.autotest_canaux(p_jours integer default 30)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare r record; v integer := 0;
begin
  for r in
    select cx.id as canal_id, ab.id as abonne_id
      from public.canaux cx
      join public.abonnes ab on ab.id = cx.abonne_id and ab.actif
     where cx.actif and cx.verifie
       and coalesce(cx.last_ok_at, cx.created_at) < now() - make_interval(days => p_jours)
  loop
    insert into public.alertes (canal_id, abonne_id, type, severite, statut, payload)
    values (r.canal_id, r.abonne_id, 'test', 'info', 'en_attente',
            jsonb_build_object(
              'severite', 'info',
              'message', 'Verification automatique : ce canal fonctionne toujours et recevra '
                      || 'les alertes incendie. Aucune action de votre part n''est necessaire.'));
    v := v + 1;
  end loop;
  return v;
end;
$$;

-- ---------------------------------------------------------------------
--  Purge : ajoute la peremption des alertes et la meteo orpheline
-- ---------------------------------------------------------------------
-- Le type de retour change (void -> jsonb) : create or replace ne suffit pas.
drop function if exists public.purger();

create function public.purger()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare v_perimees integer;
begin
  select public.perimer_alertes() into v_perimees;
  delete from public.detections where acq_ts < now() - interval '90 days';
  delete from public.evenements where statut = 'clos' and clos_at < now() - interval '365 days';
  delete from public.runs    where started_at < now() - interval '30 days';
  delete from public.alertes where created_at < now() - interval '180 days';
  delete from public.quotas  where fenetre < now() - interval '2 days';
  delete from public.creneaux_traites where traite_at < now() - interval '7 days';
  delete from public.abonnes a
   where coalesce(a.last_seen_at, a.created_at) < now() - interval '60 days'
     and not exists (select 1 from public.canaux c where c.abonne_id = a.id)
     and not exists (select 1 from public.zone_abonnes z where z.abonne_id = a.id);
  return jsonb_build_object('alertes_perimees', v_perimees);
end;
$$;

-- ---------------------------------------------------------------------
--  3. PLANIFICATION DECLARATIVE
--     On retire d'abord toute tache visant nos propres fonctions, y
--     compris celles creees a la main hors migration, pour ne pas se
--     retrouver avec deux collectes concurrentes.
-- ---------------------------------------------------------------------
do $$
declare j record;
begin
  for j in
    select jobname from cron.job
     where command ~ '(poll-firms|poll-lsasaf|poll-meteo|poll-adsb|probe-mtg|dispatch'
                  || '|verifier_sante|purger|clore_signalements|notifier_fin_evenements'
                  || '|autotest_canaux|appeler_fonction)'
  loop
    perform cron.unschedule(j.jobname);
  end loop;
end $$;

-- Collecte polaire : socle. Les fichiers amont sont regeneres environ
-- une fois par heure, inutile d'aller plus vite que 10 minutes.
select cron.schedule('poll-firms', '*/10 * * * *',
  $$select public.appeler_fonction('poll-firms')$$);

-- Collecte geostationnaire : cadence du produit, 15 minutes.
select cron.schedule('poll-lsasaf', '*/15 * * * *',
  $$select public.appeler_fonction('poll-lsasaf')$$);

-- Meteo : deux fois par heure suffit, les variables evoluent lentement.
select cron.schedule('poll-meteo', '5,35 * * * *',
  $$select public.appeler_fonction('poll-meteo')$$);

-- Corroboration aerienne : sans effet tant que config.adsb est inactif.
select cron.schedule('poll-adsb', '*/5 * * * *',
  $$select public.appeler_fonction('poll-adsb')$$);

-- Vidage de la file d'alertes.
select cron.schedule('dispatch', '*/2 * * * *',
  $$select public.appeler_fonction('dispatch')$$);

select cron.schedule('verifier-sante', '*/15 * * * *',
  $$select public.verifier_sante()$$);

select cron.schedule('clore-signalements', '25 * * * *',
  $$select public.clore_signalements()$$);

-- Fin d'alerte : verifie aussi hors collecte, pour qu'un evenement
-- s'eteigne meme si plus aucune detection n'arrive.
select cron.schedule('notifier-fin', '10,40 * * * *',
  $$select public.notifier_fin_evenements()$$);

select cron.schedule('purger', '15 3 * * *',
  $$select public.purger()$$);

select cron.schedule('autotest-canaux', '0 9 1 * *',
  $$select public.autotest_canaux()$$);

-- Veille sur MTG : ecarte aujourd'hui (publication par lots quotidiens,
-- statut Demonstration). Une note dans un document ne se relit jamais ;
-- un test mensuel automatique previendra s'il passe temps reel.
select cron.schedule('probe-mtg', '30 4 1 * *',
  $$select public.appeler_fonction('probe-mtg')$$);

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
