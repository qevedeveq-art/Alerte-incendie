create extension if not exists postgis with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- Cache des contours de communes (source: geo.api.gouv.fr / IGN Admin Express)
create table public.communes (
  code          text primary key,
  nom           text not null,
  departement   text not null,
  population    integer,
  surface_ha    numeric,
  centre        geography(Point, 4326),
  geom          geography(MultiPolygon, 4326) not null,
  loaded_at     timestamptz not null default now()
);
create index communes_geom_idx on public.communes using gist (geom);
create index communes_dep_idx  on public.communes (departement);
create index communes_nom_idx  on public.communes using gin (to_tsvector('french', nom));

alter table public.communes enable row level security;
comment on table public.communes is 'Contours communaux simplifies (~56 m) servant au calcul des zones surveillees et des communes limitrophes.';;