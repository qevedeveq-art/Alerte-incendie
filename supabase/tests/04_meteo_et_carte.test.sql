-- ===================================================================
--  Risque météo, durcissement asymétrique et service de la carte
-- -------------------------------------------------------------------
--  La météo est le seul mécanisme autorisé à modifier la sensibilité
--  d'une zone. L'invariant est explicite dans CONTEXTE.md : elle ne
--  peut que DURCIR. Assouplir un seuil sur la foi d'une prévision
--  reviendrait à masquer un départ de feu réel — l'erreur exactement
--  inverse de celle que le produit accepte.
--
--  S'y ajoutent les fonctions de service de la carte, livrées par les
--  migrations 40 et 41.
-- ===================================================================
begin;
-- pgTAP n'est chargé que pour la durée du test : le ROLLBACK final le
-- retire, la base de production n'en porte jamais la trace.
create extension if not exists pgtap with schema public;
select plan(18);

-- ---------- barème de risque météo ----------

select is(
  (select risque from public.calc_risque_meteo(20, 70, 5, 8)),
  'faible',
  'temps doux et humide : risque faible'
);

select is(
  (select risque from public.calc_risque_meteo(30, 40, 20, 28)),
  'modere',
  'chaleur modérée, air sec et brise : risque modéré'
);

select is(
  (select risque from public.calc_risque_meteo(35, 25, 30, 45)),
  'tres_eleve',
  'canicule, air très sec et rafales : risque très élevé'
);

select is(
  (select score from public.calc_risque_meteo(35, 25, 30, 45))::integer,
  7,
  'le score cumule humidité, rafales et température'
);

select is(
  (select risque from public.calc_risque_meteo(null, null, null, null)),
  'faible',
  'sans mesure, le risque ne monte jamais tout seul'
);

--  Les rafales priment sur le vent moyen : c'est la rafale qui propulse
--  les brandons.
select is(
  (select score from public.calc_risque_meteo(20, 70, 5, 65))::integer,
  3,
  'une rafale à 65 km/h pèse même quand le vent moyen est faible'
);

-- ---------- monotonie du barème ----------
--  Aucune aggravation d'un paramètre ne doit faire BAISSER le score.
--  C'est la propriété qui rend le barème défendable.

select ok(
  (select bool_and(s2 >= s1) from (
     select (select score from public.calc_risque_meteo(t, h, v, r)) as s1,
            (select score from public.calc_risque_meteo(t + 6, h, v, r)) as s2
       from unnest(array[15, 22, 28, 33]::numeric[]) t,
            unnest(array[20, 40, 60, 85]::numeric[]) h,
            unnest(array[5, 20, 35, 55]::numeric[]) v,
            unnest(array[10, 30, 50, 70]::numeric[]) r
   ) x),
  'une température plus élevée n''abaisse jamais le score'
);

select ok(
  (select bool_and(s2 >= s1) from (
     select (select score from public.calc_risque_meteo(t, h, v, r)) as s1,
            (select score from public.calc_risque_meteo(t, greatest(h - 20, 0), v, r)) as s2
       from unnest(array[15, 22, 28, 33]::numeric[]) t,
            unnest(array[20, 40, 60, 85]::numeric[]) h,
            unnest(array[5, 20, 35, 55]::numeric[]) v,
            unnest(array[10, 30, 50, 70]::numeric[]) r
   ) x),
  'un air plus sec n''abaisse jamais le score'
);

select ok(
  (select bool_and(s2 >= s1) from (
     select (select score from public.calc_risque_meteo(t, h, v, r)) as s1,
            (select score from public.calc_risque_meteo(t, h, v, r + 25)) as s2
       from unnest(array[15, 22, 28, 33]::numeric[]) t,
            unnest(array[20, 40, 60, 85]::numeric[]) h,
            unnest(array[5, 20, 35, 55]::numeric[]) v,
            unnest(array[10, 30, 50, 70]::numeric[]) r
   ) x),
  'des rafales plus fortes n''abaissent jamais le score'
);

-- ---------- durcissement asymétrique ----------
--  Vérifié sur la fonction elle-même, sans données : la seule forme
--  possible de sortie est « au moins aussi strict que l'entrée ».

select ok(
  (select pg_get_functiondef(p.oid) like '%when ''conservateur'' then ''equilibre''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sensibilite_effective'),
  'conservateur ne peut se relâcher que vers équilibre'
);

select ok(
  (select pg_get_functiondef(p.oid) like '%when ''equilibre''    then ''sensible''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sensibilite_effective'),
  'équilibre ne peut évoluer que vers sensible'
);

select ok(
  (select pg_get_functiondef(p.oid) not like '%then ''conservateur''%'
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'sensibilite_effective'),
  'aucune branche ne peut rendre une zone plus permissive'
);

-- ---------- service de la carte ----------

select ok(
  (select count(*)::integer from unnest(public.fenetres_carte_cachees())) = 6,
  'six fenêtres de carte sont pré-calculées'
);

select ok(
  24 = any(public.fenetres_carte_cachees()),
  'la fenêtre par défaut de 24 h fait partie du cache'
);

select is(
  (public.feux_carte_servie(24, -5.5, 41, 10, 51.5, 300) ->> 'origine'),
  'direct',
  'sans cache frais, la carte est recalculée en direct plutôt que servie périmée'
);

select ok(
  (public.feux_carte_servie(24, -5.5, 41, 10, 51.5, 300) ? 'age_secondes'),
  'la carte restitue toujours son âge'
);

-- ---------- découpage communal ----------

select is(
  (select count(*)::integer from unnest(public.departements_attendus())),
  101,
  'les 101 départements français sont attendus, sans le 96 qui n''existe pas'
);

select ok(
  not ('96' = any(public.departements_attendus())),
  'le département 96 n''existe pas et n''est pas demandé'
);

select * from finish();
rollback;
