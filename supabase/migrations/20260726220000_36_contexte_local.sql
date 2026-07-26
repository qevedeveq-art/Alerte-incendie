-- =====================================================================
--  INFORMATIONS LOCALES ET CONTEXTE (ETAPE ACTUALITES LOCALES)
-- ---------------------------------------------------------------------
--  Cette migration ajoute le domaine contextuel sans modifier les détections :
--    1. sources_contexte (catalogue des flux officiels/médias/sociaux)
--    2. mentions_contexte (articles, communiqués, publications normalisés)
--    3. evenement_mentions (liaison événement-mention avec score explicable)
--    4. contexte_moderation_audit (journal d'audit des modérations)
--    5. fonction de purge dédiée et intégration cron
--
--  INVARIANT INVIOLABLE : Le contexte ne modifie ni score, ni severite,
--  ni familles_independantes, et ne déclenche aucune alerte.
-- =====================================================================

-- 1. Catalogue des sources de contexte
create table if not exists public.sources_contexte (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  nom text not null,
  type text not null check (type in ('autorite', 'media', 'social', 'partenaire')),
  url_flux text,
  licence text,
  attribution text,
  mode text not null default 'shadow' check (mode in ('shadow', 'actif', 'desactive')),
  actif boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.sources_contexte is
  'Catalogue des flux et sources contextuelles d informations locales.';

-- 2. Mentions contextuelles normalisées
create table if not exists public.mentions_contexte (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources_contexte(id) on delete cascade,
  externe_hash text not null unique,
  url_canonical text not null,
  titre text not null,
  resume text,
  date_publication timestamptz not null,
  code_insee text,
  commune_nom text,
  statut text not null default 'candidat' check (statut in ('candidat', 'publie', 'rejete', 'retire')),
  created_at timestamptz not null default now()
);

comment on table public.mentions_contexte is
  'Articles, communiqués et publications publiques candidats ou associés.';

-- 3. Association événement <-> mention avec score explicable
create table if not exists public.evenement_mentions (
  id uuid primary key default gen_random_uuid(),
  evenement_id uuid not null references public.evenements(id) on delete cascade,
  mention_id uuid not null references public.mentions_contexte(id) on delete cascade,
  score integer not null check (score between 0 and 100),
  raisons jsonb not null default '[]'::jsonb,
  distance_km numeric(6,2),
  ecart_heures numeric(6,2),
  decision text not null default 'a_valider' check (decision in ('a_valider', 'associe', 'rejete', 'retire')),
  created_at timestamptz not null default now(),
  unique(evenement_id, mention_id)
);

comment on table public.evenement_mentions is
  'Liaison explicable entre un événement de feu et une mention locale.';

-- 4. Audit de modération immuable
create table if not exists public.contexte_moderation_audit (
  id uuid primary key default gen_random_uuid(),
  mention_id uuid not null references public.mentions_contexte(id) on delete cascade,
  evenement_id uuid references public.evenements(id) on delete set null,
  decision text not null,
  motif text not null,
  acteur_hash text not null,
  created_at timestamptz not null default now()
);

comment on table public.contexte_moderation_audit is
  'Journal d audit immuable des décisions de modération du contexte local.';

-- 5. Activer Row Level Security (RLS) sans aucune policy publique
alter table public.sources_contexte enable row level security;
alter table public.mentions_contexte enable row level security;
alter table public.evenement_mentions enable row level security;
alter table public.contexte_moderation_audit enable row level security;

-- 6. Révocation des privilèges par défaut
revoke all on table public.sources_contexte from public, anon, authenticated;
revoke all on table public.mentions_contexte from public, anon, authenticated;
revoke all on table public.evenement_mentions from public, anon, authenticated;
revoke all on table public.contexte_moderation_audit from public, anon, authenticated;

grant select, insert, update, delete on table public.sources_contexte to service_role;
grant select, insert, update, delete on table public.mentions_contexte to service_role;
grant select, insert, update, delete on table public.evenement_mentions to service_role;
grant select, insert, update, delete on table public.contexte_moderation_audit to service_role;

-- 7. Procédure de purge automatique du domaine contexte local
create or replace function public.purger_contexte_local()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Candidates rejetées ou non associées après 24h
  delete from public.mentions_contexte
   where statut = 'rejete'
     and created_at < now() - interval '24 hours';

  delete from public.mentions_contexte m
   where m.statut = 'candidat'
     and m.created_at < now() - interval '48 hours'
     and not exists (
       select 1 from public.evenement_mentions em where em.mention_id = m.id
     );

  -- Mentions associées aux événements clos (30 jours pour médias/autorités)
  delete from public.mentions_contexte m
   where m.statut in ('publie', 'retire')
     and m.created_at < now() - interval '30 days';

  -- Audit immuable conservé 180 jours
  delete from public.contexte_moderation_audit
   where created_at < now() - interval '180 days';
end;
$$;

revoke all on function public.purger_contexte_local() from public, anon, authenticated;
grant execute on function public.purger_contexte_local() to service_role;

-- 8. Insertion des sources initiales par défaut (Désactivées / Shadow)
insert into public.sources_contexte (code, nom, type, url_flux, licence, attribution, mode, actif)
values
  ('pref_sdis_rss', 'Flux RSS Officiels (Préfectures & SDIS)', 'autorite', null, 'Open License', 'Préfecture / SDIS', 'shadow', false),
  ('gdelt_news', 'GDELT Global News Index', 'media', 'https://api.gdeltproject.org/api/v2/doc/doc', 'CC-BY', 'GDELT Project', 'shadow', false)
on conflict (code) do nothing;

-- 9. Déclarer la tâche pg_cron pour le collecteur de contexte
select cron.schedule(
  'poll-contexte',
  '*/30 * * * *',
  $$ select public.appeler_fonction('poll-contexte') $$
) where not exists (
  select 1 from cron.job where jobname = 'poll-contexte'
);
