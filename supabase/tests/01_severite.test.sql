-- ===================================================================
--  Règles de sévérité — le cœur du produit
-- -------------------------------------------------------------------
--  Ces règles décident si un abonné est réveillé la nuit. Jusqu'ici
--  elles n'étaient vérifiées par aucun test : le rejeu des migrations
--  contrôle la syntaxe, pas le comportement. Une inversion de seuil
--  serait passée en production sans résistance.
--
--  calc_severite est immutable et pure : elle se teste sans données.
-- ===================================================================
begin;
-- pgTAP n'est chargé que pour la durée du test : le ROLLBACK final le
-- retire, la base de production n'en porte jamais la trace.
create extension if not exists pgtap with schema public;
select plan(22);

-- ---------- profil « équilibre », celui utilisé par défaut ----------

select is(
  public.calc_severite('equilibre', 1, 8, 80, true, 1, 3000),
  'alerte',
  'un pixel géostationnaire isolé dans la commune ne dépasse pas alerte'
);

select is(
  public.calc_severite('equilibre', 1, 12, 80, true, 1, 375),
  'critique',
  'le même signal, mais localisé à 375 m et au-dessus de 10 MW, passe critique'
);

select is(
  public.calc_severite('equilibre', 1, 8, 80, true, 1, 1000),
  'alerte',
  'à 1 km de résolution, une FRP de 8 MW reste sous le seuil de 10 MW'
);

select is(
  public.calc_severite('equilibre', 3, 5, 30, false, 1, 375),
  'critique',
  'trois points chauds suffisent, quelles que soient la confiance et la position'
);

select is(
  public.calc_severite('equilibre', 1, 50, 10, false, 1, 3000),
  'critique',
  'une FRP de 50 MW est critique même à 3 km de résolution'
);

select is(
  public.calc_severite('equilibre', 1, 1, 10, false, 2, 3000),
  'critique',
  'deux familles concordantes sont critiques indépendamment de la finesse'
);

select is(
  public.calc_severite('equilibre', 1, 1, 50, false, 1, 375),
  'alerte',
  'une confiance nominale seule vaut alerte'
);

select is(
  public.calc_severite('equilibre', 1, 1, 20, false, 1, 375),
  'info',
  'une confiance faible et isolée reste info'
);

select is(
  public.calc_severite('equilibre', 1, null, null, false, 1, null),
  'info',
  'des valeurs absentes ne créent pas de sévérité'
);

-- ---------- profil « sensible » : jamais moins strict ----------

select ok(
  public.calc_severite('sensible', 2, 0, 0, false, 1, 3000) = 'critique',
  'sensible : deux points chauds suffisent'
);

select ok(
  public.calc_severite('sensible', 1, 0, 0, false, 1, 3000) = 'alerte',
  'sensible : le plancher est alerte, jamais info'
);

-- ---------- profil « conservateur » ----------

select is(
  public.calc_severite('conservateur', 3, 30, 90, true, 1, 375),
  'alerte',
  'conservateur : trois points chauds ne suffisent pas pour critique'
);

select is(
  public.calc_severite('conservateur', 4, 0, 0, false, 1, 375),
  'critique',
  'conservateur : quatre points chauds déclenchent critique'
);

select is(
  public.calc_severite('conservateur', 1, 10, 90, true, 1, 375),
  'info',
  'conservateur : la position dans la commune n''est pas un raccourci'
);

-- ---------- monotonie entre profils ----------
--  Un même signal ne doit jamais être jugé plus grave en conservateur
--  qu'en sensible. C'est la propriété qui donne un sens aux profils.

select ok(
  (
    select bool_and(
      case public.calc_severite('sensible', n, f, c, d, s, r)
        when 'critique' then 3 when 'alerte' then 2 else 1 end
      >=
      case public.calc_severite('conservateur', n, f, c, d, s, r)
        when 'critique' then 3 when 'alerte' then 2 else 1 end
    )
    from generate_series(1, 5) n,
         unnest(array[0, 10, 30, 60, 120]::numeric[]) f,
         unnest(array[0, 40, 60, 90]) c,
         unnest(array[true, false]) d,
         unnest(array[1, 2]) s,
         unnest(array[375, 1000, 3000]) r
  ),
  'sensible n''est jamais plus indulgent que conservateur, sur 1 200 combinaisons'
);

-- ---------- familles de sources ----------
--  VIIRS et MODIS ne se corroborent pas : c'est l'invariant qui empêche
--  de gonfler artificiellement la confiance.

select is(public.famille_source('VIIRS_SNPP'), 'polaire', 'VIIRS S-NPP est polaire');
select is(public.famille_source('VIIRS_NOAA20'), 'polaire', 'VIIRS NOAA-20 est polaire');
select is(public.famille_source('MODIS'), 'polaire', 'MODIS est polaire, comme VIIRS');
select is(public.famille_source('MSG_SEVIRI'), 'geostationnaire', 'Meteosat est géostationnaire');
select is(public.famille_source('CITOYEN'), 'citoyen', 'les témoins forment leur propre famille');
select is(public.famille_source('ADSB'), 'aerien', 'la corroboration aérienne est séparée');

select ok(
  (select count(distinct public.famille_source(s))
     from unnest(array['VIIRS_SNPP', 'VIIRS_NOAA20', 'VIIRS_NOAA21', 'MODIS']) s) = 1,
  'les quatre capteurs polaires ne comptent que pour une seule famille'
);

select * from finish();
rollback;
