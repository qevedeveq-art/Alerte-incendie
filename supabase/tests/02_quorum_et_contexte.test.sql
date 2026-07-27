-- ===================================================================
--  Quorum citoyen, barème de contexte et reconnaissance de toponyme
-- -------------------------------------------------------------------
--  Le quorum arbitre entre deux erreurs opposées : croire un abuseur,
--  ou ignorer deux voisins de bonne foi derrière la même box. Le
--  barème de contexte décide si une dépêche est rattachée à un feu.
--  Aucun des deux n'était couvert.
-- ===================================================================
begin;
-- pgTAP n'est chargé que pour la durée du test : le ROLLBACK final le
-- retire, la base de production n'en porte jamais la trace.
create extension if not exists pgtap with schema public;
select plan(21);

-- ---------- quorum : 2 personnes sur 2 réseaux, ou 3 personnes ----------

select ok(public.signalement_confirmable(2, 2), '2 personnes sur 2 réseaux : confirmé');
select ok(not public.signalement_confirmable(2, 1), '2 personnes sur 1 réseau : pas encore');
select ok(public.signalement_confirmable(3, 1), '3 personnes sur 1 réseau : confirmé malgré le NAT');
select ok(not public.signalement_confirmable(1, 1), 'une seule personne ne confirme jamais');
select ok(not public.signalement_confirmable(1, 5), 'un seul témoin sur cinq réseaux reste un seul témoin');
select ok(public.signalement_confirmable(4, 2), 'au-delà du seuil, reste confirmé');

-- ---------- normalisation et toponymes ----------

select is(
  public.normaliser_toponyme('Saint-Paul-de-Fenouillet'),
  'saint paul de fenouillet',
  'accents, casse et ponctuation sont neutralisés'
);

select is(
  public.normaliser_toponyme('Uzès'),
  'uzes',
  'les accents disparaissent'
);

select ok(
  public.toponyme_present(public.normaliser_toponyme('Incendie à Aix-en-Provence ce matin'), 'Aix-en-Provence'),
  'la commune exacte est reconnue dans un titre'
);

select ok(
  not public.toponyme_present(public.normaliser_toponyme('Incendie à Aixe-sur-Vienne'), 'Aix'),
  'Aix n''est pas reconnu dans Aixe : les frontières de mot sont respectées'
);

select ok(
  not public.toponyme_present(public.normaliser_toponyme('un texte quelconque'), ''),
  'une commune vide ne se reconnaît nulle part'
);

select ok(
  not public.toponyme_present(public.normaliser_toponyme('les feux de la rampe'), 'Le'),
  'un nom trop court est ignoré'
);

-- ---------- barème d'association du contexte ----------

select is(
  (public.score_association_contexte(
    public.normaliser_toponyme('Incendie en cours à Cornebarrieu, les pompiers sur place'),
    'Cornebarrieu', false, 1.0, null, 2000
  ) ->> 'score')::integer,
  70,
  'commune exacte (35) + moins de 2 h (25) + vocabulaire (10) = 70, seuil de publication'
);

select ok(
  (public.score_association_contexte(
    public.normaliser_toponyme('Exercice incendie à Cornebarrieu'),
    'Cornebarrieu', false, 1.0, null, 2000
  ) ->> 'score')::integer < 50,
  'le marqueur « exercice » retire 60 points et passe sous le seuil'
);

select is(
  (public.score_association_contexte(
    public.normaliser_toponyme('Feu de forêt, intervention du SDIS'),
    'Cornebarrieu', false, 1.0, 500, 2000
  ) ->> 'score')::integer,
  80,
  'une coordonnée dans le rayon (45) prime sur le toponyme'
);

select ok(
  (public.score_association_contexte(
    public.normaliser_toponyme('Incendie quelque part en France'),
    'Cornebarrieu', false, 1.0, null, 2000
  ) ->> 'score')::integer < 50,
  'sans ancrage géographique, une dépêche nationale n''atteint pas le seuil'
);

select is(
  (public.score_association_contexte(
    public.normaliser_toponyme('Incendie à Cornebarrieu'),
    'Cornebarrieu', false, 30.0, null, 2000
  ) ->> 'score')::integer,
  45,
  'au-delà de 24 h, la fenêtre temporelle n''apporte plus de points'
);

select ok(
  (public.score_association_contexte(
    public.normaliser_toponyme('Incendie à Cornebarrieu'),
    'Cornebarrieu', false, 1.0, null, 2000
  ) -> 'raisons') ? 'Publication a moins de 2 h de l observation',
  'les raisons du rapprochement sont explicites'
);

select ok(
  (public.score_association_contexte('', null, false, null, null, 2000) ->> 'score')::integer = 0,
  'un contenu vide ne marque aucun point'
);

select ok(
  (public.score_association_contexte(
    public.normaliser_toponyme('Incendie maitrise a Blagnac, commune voisine'),
    'Cornebarrieu', true, 1.0, null, 2000
  ) ->> 'score')::integer = 50,
  'une commune limitrophe vaut 15 points, pas 35'
);

-- Le type de source ne doit donner aucun point : un communiqué officiel
-- générique ne se rattache pas à un feu au seul motif qu'il est officiel.
select is(
  (public.score_association_contexte(
    public.normaliser_toponyme('Prévention des incendies : les bons gestes'),
    'Cornebarrieu', false, 1.0, null, 2000
  ) ->> 'score')::integer,
  0,
  'un communiqué de prévention générique tombe à zéro'
);

select * from finish();
rollback;
