-- ===================================================================
--  SIGNALEMENTS CITOYENS
-- ---------------------------------------------------------------------
--  Troisieme niveau de detection, complementaire des deux autres :
--
--    citoyen         instantane    tres precis    non verifie
--    geostationnaire ~25 min       3 km           automatique
--    polaire         2-3 h         375 m          automatique
--
--  Un signalement confirme (2 personnes distinctes) declenche une
--  alerte de severite 'alerte', explicitement etiquetee non verifiee.
--  Elle n'atteint 'critique' que si un satellite corrobore ensuite au
--  meme endroit : la hierarchie des preuves est preservee.
--
--  Anti-abus, indispensable ici plus qu'ailleurs : quelques faux
--  positifs suffisent a ce que les gens cessent de croire aux vraies
--  alertes.
--    - un jeton d'abonne est requis (gratuit et instantane)
--    - la confirmation exige 2 abonnes ET 2 empreintes d'IP distinctes,
--      ce qui bloque l'auto-confirmation a deux appareils sur le meme
--      reseau
--    - quotas par abonne et par IP
--    - l'IP n'est jamais stockee en clair, seulement hachee avec un sel
-- ===================================================================

create table public.signalements (
  id           uuid primary key default gen_random_uuid(),
  abonne_id    uuid not null references public.abonnes(id) on delete cascade,
  groupe_id    uuid,                                  -- regroupement a 50 m
  geom         geography(Point, 4326) not null,
  lat          double precision not null,
  lon          double precision not null,
  nature       text not null default 'fumee'
                 check (nature in ('fumee', 'flammes', 'odeur', 'autre')),
  commentaire  text check (commentaire is null or length(commentaire) <= 280),
  ip_hash      text,                                  -- sha256(ip || sel), jamais l'IP
  commune_code text,
  commune_nom  text,
  statut       text not null default 'actif'
                 check (statut in ('actif', 'clos', 'rejete')),
  created_at   timestamptz not null default now()
);
create index signalements_geom_idx    on public.signalements using gist (geom);
create index signalements_groupe_idx  on public.signalements (groupe_id);
create index signalements_recents_idx on public.signalements (created_at desc) where statut = 'actif';
create unique index signalements_unicite_idx
  on public.signalements (abonne_id, groupe_id) where statut = 'actif';

comment on table public.signalements is
  'Signalements de depart de feu par les utilisateurs. Non verifies par construction.';
comment on index public.signalements_unicite_idx is
  'Un abonne ne compte qu''une fois par groupe : il ne peut pas se confirmer lui-meme en signalant deux fois.';

create table public.signalement_groupes (
  id             uuid primary key default gen_random_uuid(),
  centre         geography(Point, 4326) not null,
  nb             integer not null default 0,           -- signalements distincts
  nb_personnes   integer not null default 0,           -- abonnes distincts
  nb_reseaux     integer not null default 0,           -- empreintes d'IP distinctes
  confirme       boolean not null default false,
  confirme_at    timestamptz,
  evenement_id   uuid references public.evenements(id) on delete set null,
  commune_code   text,
  commune_nom    text,
  natures        text[] not null default '{}',
  premier_at     timestamptz not null default now(),
  dernier_at     timestamptz not null default now(),
  statut         text not null default 'actif' check (statut in ('actif', 'clos', 'rejete'))
);
create index signalement_groupes_centre_idx on public.signalement_groupes using gist (centre);
create index signalement_groupes_actifs_idx on public.signalement_groupes (dernier_at desc)
  where statut = 'actif';

alter table public.signalements        enable row level security;
alter table public.signalement_groupes enable row level security;

-- Un evenement peut desormais naitre d'un signalement : on trace son origine.
alter table public.evenements
  add column if not exists origine text not null default 'satellite'
    check (origine in ('satellite', 'citoyen', 'mixte'));

comment on column public.evenements.origine is
  'satellite : detection automatique seule. citoyen : signalements seuls, non verifie. mixte : les deux concordent, c''est le cas le plus fiable.';

-- Sel de hachage des IP, genere une fois
insert into public.config (k, v)
values ('sel_ip', to_jsonb(encode(extensions.gen_random_bytes(32), 'hex')))
on conflict (k) do nothing;;