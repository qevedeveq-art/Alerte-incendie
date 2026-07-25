-- ===================================================================
--  SURVEILLANCE DU SYSTEME LUI-MEME
--  Un systeme d'alerte muet est pire qu'absence de systeme : si le
--  moteur ne tourne plus, on previent explicitement l'abonne.
-- ===================================================================
create or replace function public.verifier_sante()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_min integer; v_dernier timestamptz; v_alertes integer := 0; r record;
begin
  select minutes_depuis_poll, dernier_poll_ok into v_min, v_dernier from public.v_sante;

  -- Pas de poll reussi depuis 45 min : on previent (au plus une fois par 6 h)
  if v_min is null or v_min > 45 then
    if not exists (
      select 1 from public.alertes
      where type = 'heartbeat' and created_at > now() - interval '6 hours'
    ) then
      for r in
        select cx.id as canal_id, ab.id as abonne_id
        from public.canaux cx
        join public.abonnes ab on ab.id = cx.abonne_id and ab.actif
        where cx.actif
      loop
        insert into public.alertes (canal_id, abonne_id, type, severite, statut, payload)
        values (r.canal_id, r.abonne_id, 'heartbeat', 'critique', 'en_attente',
                jsonb_build_object(
                  'zone', 'Systeme', 'commune', 'Surveillance interrompue',
                  'dans_commune', true, 'distance_m', 0, 'severite', 'critique',
                  'nb_detections', 0, 'frp_max', null, 'sources', array['systeme'],
                  'lat', 0, 'lon', 0,
                  'debut_ts', coalesce(v_dernier, now()),
                  'evenement_id', 'heartbeat',
                  'message', format('Aucune collecte satellite reussie depuis %s minutes. Les alertes incendie sont peut-etre suspendues.', coalesce(v_min::text, 'un temps indetermine'))));
        v_alertes := v_alertes + 1;
      end loop;
    end if;
  end if;

  return jsonb_build_object('minutes_depuis_poll', v_min, 'alertes_heartbeat', v_alertes);
end;
$$;

-- Appel HTTP interne vers une Edge Function, via pg_net
create or replace function public.appeler_fonction(p_nom text, p_corps jsonb default '{}'::jsonb)
returns bigint
language plpgsql security definer set search_path = public, extensions
as $$
declare v_url text; v_key text;
begin
  select v #>> '{}' into v_key from public.config where k = 'admin_key';
  select v #>> '{}' into v_url from public.config where k = 'url_projet';
  if v_url is null then raise exception 'config.url_projet manquante'; end if;

  return net.http_post(
    url     := v_url || '/functions/v1/' || p_nom,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-admin-key', v_key),
    body    := p_corps,
    timeout_milliseconds := 55000);
end;
$$;

revoke all on function public.verifier_sante()            from anon, authenticated;
revoke all on function public.appeler_fonction(text,jsonb) from anon, authenticated;;