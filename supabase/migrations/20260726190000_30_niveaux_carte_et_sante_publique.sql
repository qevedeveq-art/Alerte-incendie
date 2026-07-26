-- ===================================================================
--  NIVEAUX DE CARTE COHERENTS ET SANTE PUBLIQUE
-- -------------------------------------------------------------------
--  Le score v29 plafonnait a 75 pour deux familles satellite : le seuil
--  "corrobore" a 85 etait donc inatteignable sans temoin ou ADS-B.
--  La classe de preuve doit reposer sur le nombre de familles vraiment
--  independantes ; l'intensite/repetition d'une famille unique ne doit
--  jamais etre presentee comme une corroboration.
--
--  Une sonde publique minimale permet aussi a GitHub Actions, exterieur
--  au projet Supabase, de detecter projet en pause et pg_cron muet.
-- ===================================================================

alter function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) rename to feux_carte_v29;

create function public.feux_carte(
  p_heures integer default 24,
  p_ouest double precision default -5.5,
  p_sud double precision default 41,
  p_est double precision default 10,
  p_nord double precision default 51.5,
  p_limite integer default 300
)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  with brut as (
    select value as feu, ordinality
    from jsonb_array_elements(
      public.feux_carte_v29(
        p_heures, p_ouest, p_sud, p_est, p_nord, p_limite
      )
    ) with ordinality
  ),
  classes as (
    select
      feu,
      ordinality,
      coalesce((feu->>'nb_sources_independantes')::integer, 0) as familles,
      coalesce((feu->>'score')::integer, 0) as score,
      coalesce((feu->>'nb_observations')::integer, 0) as observations,
      coalesce((feu->>'frp_max')::double precision, 0) as frp,
      feu->>'origine' as origine
    from brut
  ),
  corriges as (
    select
      ordinality,
      feu || jsonb_build_object(
        'niveau', case
          when origine = 'citoyen' then 'temoins'
          when familles >= 2 then 'corrobore'
          when score >= 60 or frp >= 50 or observations >= 3 then 'probable'
          else 'a_confirmer'
        end,
        'importance', case
          when frp >= 50 or observations >= 10 or score >= 75 then 3
          when frp >= 10 or observations >= 3 or score >= 60 then 2
          else 1
        end,
        'explication', case
          when origine = 'citoyen' then
            'Plusieurs comptes verifies concordent. Information communautaire non officielle.'
          when familles >= 2 then
            'Au moins deux familles de preuves independantes concordent a moins de 2 km et 12 h.'
          when score >= 60 or frp >= 50 or observations >= 3 then
            'Une famille de capteurs observe un signal fort ou repete ; une source independante reste necessaire.'
          else
            'Indice thermique recent et isole : il ne prouve pas a lui seul un incendie.'
        end
      ) as feu
    from classes
  )
  select coalesce(jsonb_agg(feu order by ordinality), '[]'::jsonb)
  from corriges
$$;

comment on function public.feux_carte is
  'Carte v30 : corrobore signifie au moins deux familles independantes ; probable signifie une famille unique mais forte ou repetee.';

revoke all on function public.feux_carte_v29(
  integer, double precision, double precision, double precision,
  double precision, integer
) from public, anon, authenticated;
revoke all on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) from public, anon, authenticated;
grant execute on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) to service_role;

create function public.sante_publique()
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, cron
as $$
  with s as (
    select * from public.v_sante
  ),
  c as (
    select
      max(start_time) filter (where status = 'succeeded') as dernier_cron_ok,
      max(start_time) as dernier_cron
    from cron.job_run_details
    where jobid in (
      select jobid from cron.job
      where jobname = 'verifier-sante'
    )
  ),
  valeurs as (
    select
      s.*,
      c.dernier_cron_ok,
      c.dernier_cron,
      case
        when c.dernier_cron is null then null
        else extract(epoch from now() - c.dernier_cron)::integer / 60
      end as minutes_depuis_cron
    from s cross join c
  )
  select jsonb_build_object(
    'ok',
      coalesce(minutes_depuis_poll <= 45, false)
      and (not geo_configure or coalesce(minutes_depuis_geo <= 60, false))
      and coalesce(minutes_depuis_cron <= 30, false),
    'statut', case
      when not coalesce(minutes_depuis_poll <= 45, false) then 'indisponible'
      when not coalesce(minutes_depuis_cron <= 30, false) then 'cron_en_retard'
      when geo_configure and not coalesce(minutes_depuis_geo <= 60, false) then 'degrade'
      else 'operationnel'
    end,
    'version_schema', 30,
    'verifie_at', now(),
    'collecte_polaire', jsonb_build_object(
      'dernier_succes', dernier_poll_ok,
      'age_minutes', minutes_depuis_poll,
      'ok', coalesce(minutes_depuis_poll <= 45, false)
    ),
    'collecte_geostationnaire', jsonb_build_object(
      'configuree', geo_configure,
      'dernier_succes', dernier_geo_ok,
      'age_minutes', minutes_depuis_geo,
      'ok', not geo_configure or coalesce(minutes_depuis_geo <= 60, false)
    ),
    'planification', jsonb_build_object(
      'dernier_passage', dernier_cron,
      'dernier_succes', dernier_cron_ok,
      'age_minutes', minutes_depuis_cron,
      'ok', coalesce(minutes_depuis_cron <= 30, false)
    ),
    'detections_24h', detections_24h,
    'capteurs_actifs_24h', capteurs_actifs_24h
  )
  from valeurs
$$;

comment on function public.sante_publique is
  'Etat operationnel agrege sans secret ni donnee abonne, expose par une route publique limitee.';

revoke all on function public.sante_publique() from public, anon, authenticated;
grant execute on function public.sante_publique() to service_role;
