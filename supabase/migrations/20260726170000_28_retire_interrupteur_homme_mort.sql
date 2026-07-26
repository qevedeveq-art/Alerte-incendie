-- ===================================================================
--  RETRAIT DE L'INTERRUPTEUR D'HOMME MORT EXTERNE
-- ---------------------------------------------------------------------
--  La migration 26 faisait pinger un service tiers par verifier_sante()
--  tant que le systeme allait bien, de sorte que l'arret des pings
--  signale une panne totale. Ce mecanisme est retire ici.
--
--  Migration en avant plutot que reecriture de la 26 : celle-ci est
--  peut-etre deja appliquee en production, et Supabase ne rejoue pas
--  une version deja enregistree.
--
--  Consequence assumee : le controle de sante redevient interne au
--  projet qu'il surveille. Si le projet Supabase tombe, se met en pause
--  ou sature, plus rien ne previent — c'est le seul scenario de panne
--  que le heartbeat interne ne peut structurellement pas attraper.
--  La detection d'une collecte muette (45 min sans poll reussi) et la
--  degradation du geostationnaire continuent de fonctionner normalement.
-- ===================================================================

create or replace function public.verifier_sante()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_min integer; v_dernier timestamptz;
  v_geo integer; v_geo_conf boolean;
  v_alertes integer := 0; r record;
  v_msg text; v_sev text;
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
    return jsonb_build_object('minutes_depuis_poll', v_min, 'minutes_depuis_geo', v_geo,
                              'alertes_heartbeat', 0);
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

drop function if exists public.ping_externe();
delete from public.config where k = 'heartbeat_url';

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
