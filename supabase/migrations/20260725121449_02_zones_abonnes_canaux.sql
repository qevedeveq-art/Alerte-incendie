-- ============ ZONES SURVEILLEES ============
create table public.zones (
  id                  uuid primary key default gen_random_uuid(),
  nom                 text not null,
  commune_code        text not null references public.communes(code),
  inclure_limitrophes boolean not null default true,
  buffer_m            integer not null default 3000 check (buffer_m between 0 and 50000),
  sensibilite         text not null default 'equilibre'
                        check (sensibilite in ('sensible','equilibre','conservateur')),
  actif               boolean not null default true,
  limitrophes         text[] not null default '{}',
  geom                geography(MultiPolygon, 4326),
  created_at          timestamptz not null default now(),
  unique (commune_code, buffer_m, inclure_limitrophes)
);
create index zones_geom_idx on public.zones using gist (geom);

-- ============ ABONNES ============
create table public.abonnes (
  id            uuid primary key default gen_random_uuid(),
  token         text not null unique default encode(extensions.gen_random_bytes(24), 'hex'),
  nom           text,
  email         text,
  seuil_min     text not null default 'alerte' check (seuil_min in ('info','alerte','critique')),
  quiet_start   time,                       -- heures silencieuses (severite < critique)
  quiet_end     time,
  fuseau        text not null default 'Europe/Paris',
  actif         boolean not null default true,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);
create index abonnes_token_idx on public.abonnes (token);

create table public.zone_abonnes (
  zone_id   uuid not null references public.zones(id) on delete cascade,
  abonne_id uuid not null references public.abonnes(id) on delete cascade,
  primary key (zone_id, abonne_id)
);

-- ============ CANAUX DE NOTIFICATION ============
create table public.canaux (
  id           uuid primary key default gen_random_uuid(),
  abonne_id    uuid not null references public.abonnes(id) on delete cascade,
  type         text not null check (type in ('webpush','telegram','email')),
  destination  jsonb not null,             -- push: {endpoint,keys}; telegram: {chat_id}; email: {adresse}
  libelle      text,
  actif        boolean not null default true,
  verifie      boolean not null default false,
  echecs       integer not null default 0,
  last_ok_at   timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);
create index canaux_abonne_idx on public.canaux (abonne_id) where actif;
create unique index canaux_dedup_idx on public.canaux (abonne_id, type, md5(destination::text));

alter table public.zones          enable row level security;
alter table public.abonnes        enable row level security;
alter table public.zone_abonnes   enable row level security;
alter table public.canaux         enable row level security;;