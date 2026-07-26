-- ===================================================================
--  RAYON D'INCERTITUDE SPATIAL ET RESTITUTION ENRICHIE
-- -------------------------------------------------------------------
--  Cette migration enrichit la fonction public.feux_carte avec le champ
--  explicite rayon_incertitude_m (par défaut 2000 m) pour matérialiser
--  l'emprise spatiale du regroupement d'observations sur Leaflet.
--
--  Sécurité : RLS active, privilèges révoqués à PUBLIC/anon/authenticated.
-- ===================================================================

create or replace function public.feux_carte(
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
        'rayon_incertitude_m', 2000,
        'explication', case
          when origine = 'citoyen' then
            'Plusieurs comptes vérifiés concordent. Information communautaire non officielle.'
          when familles >= 2 then
            'Au moins deux familles de preuves indépendantes concordent à moins de 2 km et 12 h.'
          when score >= 60 or frp >= 50 or observations >= 3 then
            'Une famille de capteurs observe un signal fort ou répété ; une source indépendante reste nécessaire.'
          else
            'Indice thermique récent et isolé : il ne prouve pas à lui seul un incendie.'
        end
      ) as feu
    from classes
  )
  select coalesce(jsonb_agg(feu order by ordinality), '[]'::jsonb)
  from corriges
$$;

comment on function public.feux_carte is
  'Carte v37 : restitue le rayon d incertitude spatiale rayon_incertitude_m (2000 m).';

revoke all on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) from public, anon, authenticated;

grant execute on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) to service_role;
