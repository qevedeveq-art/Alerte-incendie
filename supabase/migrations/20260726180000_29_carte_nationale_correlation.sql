-- ===================================================================
--  CARTE NATIONALE ET CORRELATION DES SOURCES
-- -------------------------------------------------------------------
--  La collecte automatique couvre désormais au minimum la métropole et
--  la Corse, même sans zone abonnée. Cette fonction publique indirecte
--  (appelée uniquement par l'Edge Function avec le service role) regroupe
--  les pixels proches et distingue les familles de preuves indépendantes.
--
--  Plusieurs satellites polaires ne valent donc pas plusieurs familles :
--  VIIRS et MODIS sont regroupés sous "polaire". Meteosat, les groupes
--  citoyens confirmés et la corroboration aérienne comptent séparément.
-- ===================================================================

create or replace function public.famille_source(p_source text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_source like 'VIIRS_%' or p_source = 'MODIS' then 'polaire'
    when p_source like 'MSG_%' or p_source like 'MTG_%' then 'geostationnaire'
    when p_source = 'CITOYEN' then 'citoyen'
    when p_source = 'ADSB' then 'aerien'
    else 'autre'
  end
$$;

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
with
parametres as (
  select
    least(greatest(coalesce(p_heures, 24), 1), 72) as heures,
    least(greatest(coalesce(p_limite, 300), 1), 500) as limite
),
pixels as (
  select
    d.*,
    public.famille_source(d.source) as famille,
    st_clusterdbscan(
      st_transform(d.geom::geometry, 3857),
      eps => 2000,
      minpoints => 1
    ) over () as cluster_id
  from public.detections d
  cross join parametres p
  where not d.permanente
    and d.acq_ts >= now() - make_interval(hours => p.heures)
    and d.lon between least(p_ouest, p_est) and greatest(p_ouest, p_est)
    and d.lat between least(p_sud, p_nord) and greatest(p_sud, p_nord)
),
clusters_bruts as (
  select
    cluster_id,
    st_centroid(st_collect(geom::geometry)) as centre,
    min(acq_ts) as premier_at,
    max(acq_ts) as dernier_at,
    count(*)::integer as nb_observations,
    max(frp)::double precision as frp_max,
    min(resolution_m)::integer as resolution_m,
    max(coalesce(confiance_num, 0))::integer as confiance_max,
    array_agg(distinct source order by source) as sources_satellite,
    array_agg(distinct famille order by famille) as familles_satellite
  from pixels
  group by cluster_id
),
clusters_enrichis as (
  select
    c.*,
    coalesce(ev.sources, '{}'::text[]) as sources_evenement,
    coalesce(sig.nb_groupes, 0)::integer as nb_groupes_citoyens,
    sig.commune
  from clusters_bruts c
  left join lateral (
    select array_agg(distinct s order by s) as sources
    from public.evenements e
    cross join lateral unnest(e.sources) s
    cross join parametres p
    where e.statut = 'actif'
      and e.derniere_maj >= now() - make_interval(hours => p.heures)
      and st_dwithin(e.centre, c.centre::geography, 2000)
  ) ev on true
  left join lateral (
    select
      count(*) as nb_groupes,
      min(g.commune_nom) as commune
    from public.signalement_groupes g
    where g.statut = 'actif'
      and g.confirme
      and g.dernier_at >= c.premier_at - interval '12 hours'
      and g.premier_at <= c.dernier_at + interval '12 hours'
      and st_dwithin(g.centre, c.centre::geography, 2000)
  ) sig on true
),
clusters_sources as (
  select
    c.*,
    array(
      select distinct x
      from unnest(
        c.sources_satellite ||
        c.sources_evenement ||
        case when c.nb_groupes_citoyens > 0 then array['CITOYEN'] else '{}'::text[] end
      ) x
      order by x
    ) as sources
  from clusters_enrichis c
),
clusters_scores as (
  select
    c.*,
    array(
      select distinct public.famille_source(x)
      from unnest(c.sources) x
      order by public.famille_source(x)
    ) as familles,
    least(
      99,
      50
      + least(c.confiance_max / 10, 10)
      + case
          when 'polaire' = any(c.familles_satellite)
           and 'geostationnaire' = any(c.familles_satellite) then 15
          else 0
        end
      + case when c.nb_groupes_citoyens > 0 then 20 else 0 end
      + case when 'ADSB' = any(c.sources_evenement) then 10 else 0 end
    )::integer as score
  from clusters_sources c
),
feux_satellite as (
  select jsonb_build_object(
    'id', 'sat-' || md5(cluster_id::text || premier_at::text),
    'lat', st_y(centre),
    'lon', st_x(centre),
    'premier_at', premier_at,
    'dernier_at', dernier_at,
    'sources', sources,
    'familles', familles,
    'nb_observations', nb_observations,
    'nb_sources_independantes', cardinality(familles),
    'score', score,
    'niveau', case
      when score >= 85 then 'corrobore'
      when score >= 65 then 'probable'
      else 'a_confirmer'
    end,
    'frp_max', frp_max,
    'resolution_m', resolution_m,
    'commune', commune,
    'origine', 'automatique',
    'explication',
      case
        when score >= 85 then 'Plusieurs familles de preuves concordent à moins de 2 km et 12 h.'
        when score >= 65 then 'Signal thermique renforcé, à confirmer par une source indépendante.'
        else 'Indice thermique récent : il ne prouve pas à lui seul un incendie.'
      end
  ) as feu,
  score,
  dernier_at
  from clusters_scores
),
groupes_seuls as (
  select
    jsonb_build_object(
      'id', 'cit-' || g.id::text,
      'lat', st_y(g.centre::geometry),
      'lon', st_x(g.centre::geometry),
      'premier_at', g.premier_at,
      'dernier_at', g.dernier_at,
      'sources', array['CITOYEN'],
      'familles', array['citoyen'],
      'nb_observations', g.nb_personnes,
      'nb_sources_independantes', 1,
      'score', least(60, 45 + greatest(g.nb_personnes - 2, 0) * 5),
      'niveau', 'temoins',
      'frp_max', null,
      'resolution_m', 50,
      'commune', g.commune_nom,
      'origine', 'citoyen',
      'explication',
        'Plusieurs comptes vérifiés concordent. Information communautaire non officielle.'
    ) as feu,
    least(60, 45 + greatest(g.nb_personnes - 2, 0) * 5)::integer as score,
    g.dernier_at
  from public.signalement_groupes g
  cross join parametres p
  where g.statut = 'actif'
    and g.confirme
    and g.dernier_at >= now() - make_interval(hours => p.heures)
    and st_x(g.centre::geometry) between least(p_ouest, p_est) and greatest(p_ouest, p_est)
    and st_y(g.centre::geometry) between least(p_sud, p_nord) and greatest(p_sud, p_nord)
    and not exists (
      select 1
      from clusters_bruts c
      where st_dwithin(g.centre, c.centre::geography, 2000)
        and g.dernier_at >= c.premier_at - interval '12 hours'
        and g.premier_at <= c.dernier_at + interval '12 hours'
    )
),
tous as (
  select * from feux_satellite
  union all
  select * from groupes_seuls
),
limites as (
  select feu
  from tous
  order by score desc, dernier_at desc
  limit (select limite from parametres)
)
select coalesce(jsonb_agg(feu), '[]'::jsonb)
from limites
$$;

comment on function public.feux_carte is
  'Indices de feu récents agrégés pour la carte : pixels à 2 km, fenêtre citoyenne de 12 h et score par familles indépendantes.';

revoke all on function public.feux_carte(integer, double precision, double precision, double precision, double precision, integer)
  from public, anon, authenticated;
grant execute on function public.feux_carte(integer, double precision, double precision, double precision, double precision, integer)
  to service_role;
