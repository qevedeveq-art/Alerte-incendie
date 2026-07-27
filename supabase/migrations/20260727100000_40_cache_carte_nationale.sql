-- ===================================================================
--  CACHE DE LA CARTE NATIONALE
-- -------------------------------------------------------------------
--  public.feux_carte exécute un st_clusterdbscan sur toutes les
--  détections non permanentes de la fenêtre demandée, à chaque appel.
--  Or la PWA appelle /api/carte toutes les deux minutes par client
--  ouvert, plus à chaque retour au premier plan et à chaque changement
--  de période.
--
--  Aujourd'hui le volume est faible et personne ne le sent. Le jour où
--  le service devient utile — canicule, épisode de feux, reprise
--  presse — le nombre de clients et le nombre de détections augmentent
--  EN MÊME TEMPS. Le coût de la carte est alors quadratique en
--  fréquentation, et la rupture arrive au pire moment.
--
--  Ce cache rend ce coût constant : six fenêtres recalculées toutes les
--  deux minutes par pg_cron, quel que soit le nombre de visiteurs.
--
--  Deux garde-fous, parce qu'un cache sur un service d'alerte peut
--  mentir plus longtemps qu'une panne :
--    1. au-delà de FRAICHEUR_MAX, le cache est ignoré et la carte est
--       recalculée en direct — un cron arrêté ne fige pas la carte ;
--    2. l'âge du cache est restitué à l'appelant, qui peut le montrer.
-- ===================================================================

create table if not exists public.carte_cache (
  heures       integer primary key,
  contenu      jsonb not null,
  nb_groupes   integer not null default 0,
  calcule_at   timestamptz not null default now(),
  duree_ms     integer
);

comment on table public.carte_cache is
  'Résultat pré-calculé de feux_carte par fenêtre temporelle. Emprise nationale uniquement ; toute autre emprise est calculée en direct.';

alter table public.carte_cache enable row level security;
revoke all on table public.carte_cache from public, anon, authenticated;
grant select, insert, update, delete on table public.carte_cache to service_role;

-- -------------------------------------------------------------------
--  Fenêtres pré-calculées
-- -------------------------------------------------------------------
--  Celles qu'expose réellement l'interface : le sélecteur 1/6/24 h, le
--  défaut à 24 h, et les fenêtres larges. Les valeurs intermédiaires du
--  curseur temporel restent calculées en direct : elles viennent d'une
--  action délibérée, pas d'un rafraîchissement automatique.
create or replace function public.fenetres_carte_cachees()
returns integer[]
language sql
immutable
as $$ select array[1, 6, 12, 24, 48, 72] $$;

create or replace function public.rafraichir_carte_cache()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_h integer;
  v_debut timestamptz;
  v_contenu jsonb;
  v_total integer := 0;
begin
  foreach v_h in array public.fenetres_carte_cachees() loop
    v_debut := clock_timestamp();
    -- Emprise nationale et plafond maximal : une requête plus étroite
    -- peut se servir de ce résultat, l'inverse serait faux.
    v_contenu := public.feux_carte(v_h, -5.5, 41, 10, 51.5, 500);

    insert into public.carte_cache (heures, contenu, nb_groupes, calcule_at, duree_ms)
    values (
      v_h, v_contenu, jsonb_array_length(v_contenu), now(),
      (extract(epoch from (clock_timestamp() - v_debut)) * 1000)::integer
    )
    on conflict (heures) do update
      set contenu = excluded.contenu,
          nb_groupes = excluded.nb_groupes,
          calcule_at = excluded.calcule_at,
          duree_ms = excluded.duree_ms;

    v_total := v_total + 1;
  end loop;

  return jsonb_build_object('ok', true, 'fenetres', v_total);
end;
$$;

comment on function public.rafraichir_carte_cache() is
  'Recalcule les fenêtres de carte mises en cache. Appelée par pg_cron toutes les deux minutes.';

-- -------------------------------------------------------------------
--  Lecture : cache si possible, calcul direct sinon
-- -------------------------------------------------------------------
create or replace function public.feux_carte_servie(
  p_heures integer default 24,
  p_ouest double precision default -5.5,
  p_sud double precision default 41,
  p_est double precision default 10,
  p_nord double precision default 51.5,
  p_limite integer default 300
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  -- Au-delà de cette ancienneté, le cache n'est plus une optimisation
  -- mais une source d'erreur : on recalcule.
  c_fraicheur_max constant interval := interval '6 minutes';
  v_nationale boolean;
  v_ligne public.carte_cache;
  v_feux jsonb;
begin
  v_nationale := p_ouest = -5.5 and p_sud = 41 and p_est = 10 and p_nord = 51.5;

  if v_nationale and p_limite <= 500 then
    select * into v_ligne from public.carte_cache
     where heures = p_heures and calcule_at > now() - c_fraicheur_max;

    if v_ligne.heures is not null then
      -- Le cache contient au plus 500 groupes, déjà triés par score
      -- décroissant : en prendre les p_limite premiers est équivalent.
      select coalesce(jsonb_agg(feu order by ordinalite), '[]'::jsonb)
        into v_feux
        from (
          select value as feu, ordinality as ordinalite
          from jsonb_array_elements(v_ligne.contenu) with ordinality
          limit p_limite
        ) t;

      return jsonb_build_object(
        'feux', v_feux,
        'origine', 'cache',
        'calcule_at', v_ligne.calcule_at,
        'age_secondes', floor(extract(epoch from (now() - v_ligne.calcule_at)))::integer
      );
    end if;
  end if;

  return jsonb_build_object(
    'feux', public.feux_carte(p_heures, p_ouest, p_sud, p_est, p_nord, p_limite),
    'origine', 'direct',
    'calcule_at', now(),
    'age_secondes', 0
  );
end;
$$;

comment on function public.feux_carte_servie(integer, double precision, double precision, double precision, double precision, integer) is
  'Carte servie depuis le cache national quand il est frais, recalculée en direct sinon. Restitue toujours son origine et son âge.';

-- -------------------------------------------------------------------
--  Planification et purge
-- -------------------------------------------------------------------
select cron.schedule(
  'rafraichir-carte',
  '*/2 * * * *',
  $$ select public.rafraichir_carte_cache() $$
) where not exists (
  select 1 from cron.job where jobname = 'rafraichir-carte'
);

-- Premier remplissage, pour que la première requête après déploiement
-- ne tombe pas systématiquement en calcul direct.
select public.rafraichir_carte_cache();

-- -------------------------------------------------------------------
--  Droits
-- -------------------------------------------------------------------
revoke all on function public.fenetres_carte_cachees() from public, anon, authenticated;
revoke all on function public.rafraichir_carte_cache() from public, anon, authenticated;
revoke all on function public.feux_carte_servie(
  integer, double precision, double precision, double precision, double precision, integer
) from public, anon, authenticated;

grant execute on function public.fenetres_carte_cachees() to service_role;
grant execute on function public.rafraichir_carte_cache() to service_role;
grant execute on function public.feux_carte_servie(
  integer, double precision, double precision, double precision, double precision, integer
) to service_role;
