-- ===================================================================
--  NOMMER LES COMMUNES SUR LA CARTE, ET CHARGER LA FRANCE
-- -------------------------------------------------------------------
--  Constat fait sur la production le 27 juillet : tous les groupes de
--  /api/carte ont commune: null. Les pastilles affichent donc
--  « Confirmé » ou « Probable » là où un lecteur cherche d'abord un
--  LIEU. Sur une carte d'alerte, c'est l'information la plus utile.
--
--  Deux causes distinctes, corrigées ici toutes les deux :
--
--  1. feux_carte_v29 ne consulte jamais la table communes. Pour un amas
--     satellite, le nom vient uniquement d'un groupe citoyen confirmé
--     à proximité (min(g.commune_nom)) : sans témoin, pas de nom. La
--     donnée existait pourtant, à un point-dans-polygone près.
--
--  2. Seul le département 31 est chargé. Même corrigée, la résolution
--     ne nommerait rien ailleurs. Le chargement national se fait par
--     lots : les 101 départements en un appel dépasseraient largement
--     le délai maximal d'une Edge Function.
-- ===================================================================

-- -------------------------------------------------------------------
--  1. La carte nomme ce qu'elle montre
-- -------------------------------------------------------------------
--  On enrichit le résultat de feux_carte_v29 plutôt que de le réécrire :
--  la logique de regroupement et de score reste à un seul endroit.
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
      feu->>'origine' as origine,
      feu->>'id' as identifiant,
      feu->>'commune' as commune_source,
      (feu->>'lat')::double precision as lat,
      (feu->>'lon')::double precision as lon
    from brut
  ),
  rattaches as (
    select
      c.*,
      -- Nom de commune : celui déjà porté par le groupe citoyen s'il
      -- existe, sinon la commune qui contient le point.
      coalesce(
        c.commune_source,
        (
          select cm.nom from public.communes cm
          where c.lat is not null and c.lon is not null
            and st_intersects(
              cm.geom,
              st_setsrid(st_point(c.lon, c.lat), 4326)::geography
            )
          limit 1
        )
      ) as commune_resolue,
      case
        when c.identifiant like 'cit-%' then (
          select g.evenement_id
          from public.signalement_groupes g
          where g.id::text = substring(c.identifiant from 5)
        )
        else (
          select e.id
          from public.evenements e
          where e.statut = 'actif'
            and c.lat is not null and c.lon is not null
            and st_dwithin(
              e.centre,
              st_setsrid(st_point(c.lon, c.lat), 4326)::geography,
              2000
            )
          order by st_distance(
            e.centre,
            st_setsrid(st_point(c.lon, c.lat), 4326)::geography
          )
          limit 1
        )
      end as evenement_id
    from classes c
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
        'evenement_id', evenement_id,
        'commune', commune_resolue,
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
    from rattaches
  )
  select coalesce(jsonb_agg(feu order by ordinality), '[]'::jsonb)
  from corriges
$$;

comment on function public.feux_carte is
  'Carte v41 : rayon d incertitude, identifiant d evenement rattache et nom de commune resolu depuis le decoupage IGN.';

-- -------------------------------------------------------------------
--  2. Chargement national du découpage communal, par lots
-- -------------------------------------------------------------------
--  Les 101 départements en un seul appel dépasseraient le délai maximal
--  d'une Edge Function. Cette tâche en charge trois par passage, et
--  s'arrête d'elle-même quand il n'en reste aucun : pas de drapeau à
--  gérer, l'état est la table communes elle-même.
create or replace function public.departements_attendus()
returns text[]
language sql
immutable
as $$
  select array(
    select lpad(g::text, 2, '0') from generate_series(1, 19) g
    union all select unnest(array['2A', '2B'])
    union all select lpad(g::text, 2, '0') from generate_series(21, 95) g
    union all select unnest(array['971', '972', '973', '974', '976'])
    order by 1
  )
$$;

create or replace function public.departements_manquants()
returns text[]
language sql
stable
set search_path = public, extensions
as $$
  select coalesce(array_agg(d order by d), '{}'::text[])
    from unnest(public.departements_attendus()) d
   where not exists (
     select 1 from public.communes c where c.departement = d
   )
$$;

comment on function public.departements_manquants() is
  'Départements dont aucun contour communal n est encore en cache. Sert de reste-à-faire au chargement national.';

create or replace function public.charger_communes_par_lots(p_taille integer default 3)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_manquants text[];
  v_lot text[];
begin
  v_manquants := public.departements_manquants();
  if array_length(v_manquants, 1) is null then
    return jsonb_build_object('ok', true, 'reste', 0, 'message', 'découpage national complet');
  end if;

  v_lot := v_manquants[1:least(greatest(coalesce(p_taille, 3), 1), 10)];
  perform public.appeler_fonction(
    'load-communes',
    jsonb_build_object('departements', to_jsonb(v_lot))
  );

  return jsonb_build_object(
    'ok', true,
    'lot', to_jsonb(v_lot),
    'reste', array_length(v_manquants, 1) - array_length(v_lot, 1)
  );
end;
$$;

comment on function public.charger_communes_par_lots(integer) is
  'Charge les contours des départements encore absents, trois par passage. S arrête seule une fois le pays couvert.';

--  Toutes les dix minutes : assez lent pour ne pas peser sur
--  geo.api.gouv.fr, assez rapide pour couvrir la France en six heures.
select cron.schedule(
  'charger-communes',
  '*/10 * * * *',
  $$ select public.charger_communes_par_lots(3) $$
) where not exists (
  select 1 from cron.job where jobname = 'charger-communes'
);

-- -------------------------------------------------------------------
--  3. Droits
-- -------------------------------------------------------------------
revoke all on function public.departements_attendus() from public, anon, authenticated;
revoke all on function public.departements_manquants() from public, anon, authenticated;
revoke all on function public.charger_communes_par_lots(integer)
  from public, anon, authenticated;
revoke all on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) from public, anon, authenticated;

grant execute on function public.departements_attendus() to service_role;
grant execute on function public.departements_manquants() to service_role;
grant execute on function public.charger_communes_par_lots(integer) to service_role;
grant execute on function public.feux_carte(
  integer, double precision, double precision, double precision,
  double precision, integer
) to service_role;
