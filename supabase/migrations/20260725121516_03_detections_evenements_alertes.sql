-- ============ DETECTIONS SATELLITE BRUTES ============
create table public.detections (
  id            bigserial primary key,
  source        text not null,              -- VIIRS_SNPP | VIIRS_NOAA20 | VIIRS_NOAA21 | MODIS
  acq_ts        timestamptz not null,
  lat           double precision not null,
  lon           double precision not null,
  geom          geography(Point, 4326) not null,
  confiance     text,                       -- low | nominal | high  (VIIRS) / 0-100 (MODIS)
  confiance_num smallint,                   -- normalise 0-100
  frp           numeric,                    -- Fire Radiative Power (MW)
  brillance     numeric,                    -- K
  daynight      char(1),
  resolution_m  integer,
  fingerprint   text not null unique,
  permanente    boolean not null default false,
  ingested_at   timestamptz not null default now()
);
create index detections_geom_idx on public.detections using gist (geom);
create index detections_acq_idx  on public.detections (acq_ts desc);
create index detections_live_idx on public.detections (acq_ts desc) where not permanente;

-- ============ SOURCES THERMIQUES PERMANENTES (auto-apprises) ============
-- Une cellule de ~500 m qui rechauffe regulierement = usine, torchere, four... pas un incendie.
create table public.sources_permanentes (
  cell         text primary key,            -- lat/lon arrondis a 0.005 deg
  geom         geography(Point, 4326) not null,
  occurrences  integer not null default 1,
  jours_actifs integer not null default 1,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  confirmee    boolean not null default false,
  note         text
);
create index sources_perm_geom_idx on public.sources_permanentes using gist (geom);

-- ============ EVENEMENTS (clusters spatio-temporels) ============
create table public.evenements (
  id                uuid primary key default gen_random_uuid(),
  zone_id           uuid not null references public.zones(id) on delete cascade,
  statut            text not null default 'actif' check (statut in ('actif','clos')),
  severite          text not null check (severite in ('info','alerte','critique')),
  severite_notifiee text,
  centre            geography(Point, 4326) not null,
  nb_detections     integer not null default 1,
  frp_max           numeric,
  frp_total         numeric,
  sources           text[] not null default '{}',
  commune_code      text,                   -- commune reellement touchee
  commune_nom       text,
  dans_commune      boolean not null default false,  -- true si dans la commune principale
  distance_m        integer,                -- distance au centre de la commune principale
  debut_ts          timestamptz not null,
  derniere_maj      timestamptz not null default now(),
  clos_at           timestamptz
);
create index evenements_zone_idx   on public.evenements (zone_id, statut);
create index evenements_actifs_idx on public.evenements (derniere_maj desc) where statut = 'actif';
create index evenements_centre_idx on public.evenements using gist (centre);

create table public.evenement_detections (
  evenement_id uuid   not null references public.evenements(id) on delete cascade,
  detection_id bigint not null references public.detections(id) on delete cascade,
  primary key (evenement_id, detection_id)
);

-- ============ ALERTES ENVOYEES ============
create table public.alertes (
  id           uuid primary key default gen_random_uuid(),
  evenement_id uuid references public.evenements(id) on delete cascade,
  canal_id     uuid references public.canaux(id) on delete set null,
  abonne_id    uuid references public.abonnes(id) on delete cascade,
  type         text not null,               -- alerte | test | heartbeat | resume
  severite     text,
  statut       text not null default 'en_attente' check (statut in ('en_attente','envoye','echec','ignore')),
  motif_ignore text,
  payload      jsonb,
  erreur       text,
  tentatives   integer not null default 0,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index alertes_evt_idx  on public.alertes (evenement_id);
create index alertes_file_idx on public.alertes (created_at) where statut = 'en_attente';
-- Un evenement ne declenche qu'une alerte par canal et par niveau de severite
create unique index alertes_unicite_idx
  on public.alertes (evenement_id, canal_id, severite)
  where evenement_id is not null;

-- ============ JOURNAL SYSTEME / HEARTBEAT ============
create table public.runs (
  id          bigserial primary key,
  kind        text not null,               -- poll-firms | dispatch | selftest
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  stats       jsonb,
  erreur      text
);
create index runs_kind_idx on public.runs (kind, started_at desc);

create table public.config (
  k          text primary key,
  v          jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.detections           enable row level security;
alter table public.sources_permanentes  enable row level security;
alter table public.evenements           enable row level security;
alter table public.evenement_detections enable row level security;
alter table public.alertes              enable row level security;
alter table public.runs                 enable row level security;
alter table public.config               enable row level security;;