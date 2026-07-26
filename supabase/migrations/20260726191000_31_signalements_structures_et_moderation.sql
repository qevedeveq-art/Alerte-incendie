-- ===================================================================
--  SIGNALEMENTS STRUCTURES ET MODERATION TRACABLE
-- -------------------------------------------------------------------
--  Les champs libres seuls ne permettent ni comparaison fiable, ni
--  moderation explicable. Les decisions de groupe sont journalisees
--  sans exposer les auteurs ni les empreintes reseau.
-- ===================================================================

alter table public.signalements
  add column observe_at timestamptz,
  add column intensite_percue text
    check (intensite_percue is null or intensite_percue in ('faible', 'moyenne', 'forte')),
  add column vegetation text
    check (vegetation is null or vegetation in ('foret', 'broussailles', 'herbes', 'culture', 'inconnue')),
  add column proximite_habitations boolean,
  add column certitude text
    check (certitude is null or certitude in ('incertain', 'probable', 'certain'));

comment on column public.signalements.observe_at is
  'Heure de l observation declaree, limitee et validee par l Edge Function.';
comment on column public.signalements.intensite_percue is
  'Perception du temoin, jamais assimilee a une mesure FRP ou une superficie.';
comment on column public.signalements.proximite_habitations is
  'Indication declarative utile a la moderation, pas une consigne operationnelle.';

alter table public.signalement_groupes
  add column moderation_statut text not null default 'en_attente'
    check (moderation_statut in (
      'en_attente', 'confirme_quorum', 'corrobore_capteur', 'rejete', 'expire'
    )),
  add column moderation_motif text,
  add column moderation_updated_at timestamptz not null default now();

create table public.signalement_moderation_audit (
  id bigserial primary key,
  groupe_id uuid not null,
  ancien_statut text,
  nouveau_statut text not null,
  motif text,
  origine text not null default 'systeme'
    check (origine in ('systeme', 'quorum', 'capteur', 'contestation', 'moderateur')),
  created_at timestamptz not null default now()
);

create index signalement_moderation_audit_groupe_idx
  on public.signalement_moderation_audit (groupe_id, created_at desc);
alter table public.signalement_moderation_audit enable row level security;

comment on table public.signalement_moderation_audit is
  'Journal append-only des changements de statut de moderation, sans identite publique.';

create function public.tracer_moderation_groupe()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_statut text;
  v_origine text;
begin
  if new.statut = 'rejete' then
    v_statut := 'rejete';
    v_origine := 'contestation';
  elsif new.statut = 'clos' then
    v_statut := 'expire';
    v_origine := 'systeme';
  elsif new.confirme and new.evenement_id is not null and exists (
    select 1
    from public.evenements e
    cross join lateral unnest(e.sources) src
    where e.id = new.evenement_id
      and src <> 'CITOYEN'
  ) then
    v_statut := 'corrobore_capteur';
    v_origine := 'capteur';
  elsif new.confirme then
    v_statut := 'confirme_quorum';
    v_origine := 'quorum';
  else
    v_statut := 'en_attente';
    v_origine := 'systeme';
  end if;

  if tg_op = 'INSERT' or new.moderation_statut is distinct from v_statut then
    insert into public.signalement_moderation_audit (
      groupe_id, ancien_statut, nouveau_statut, motif, origine
    ) values (
      new.id,
      case when tg_op = 'UPDATE' then old.moderation_statut else null end,
      v_statut,
      new.moderation_motif,
      v_origine
    );
    new.moderation_updated_at := now();
  end if;
  new.moderation_statut := v_statut;
  return new;
end;
$$;

create trigger signalement_groupes_tracer_moderation
before insert or update of confirme, evenement_id, statut, moderation_motif
on public.signalement_groupes
for each row execute function public.tracer_moderation_groupe();

update public.signalement_groupes
set moderation_motif = moderation_motif;

create function public.mes_signalements(p_abonne uuid, p_limite integer default 50)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'groupe_id', s.groupe_id,
    'nature', s.nature,
    'observe_at', s.observe_at,
    'created_at', s.created_at,
    'commune', s.commune_nom,
    'statut', s.statut,
    'moderation_statut', g.moderation_statut,
    'moderation_motif', g.moderation_motif,
    'moderation_updated_at', g.moderation_updated_at,
    'confirme', g.confirme,
    'nb_personnes', g.nb_personnes
  ) order by s.created_at desc), '[]'::jsonb)
  from (
    select *
    from public.signalements
    where abonne_id = p_abonne
    order by created_at desc
    limit least(greatest(coalesce(p_limite, 50), 1), 100)
  ) s
  left join public.signalement_groupes g on g.id = s.groupe_id
$$;

comment on function public.mes_signalements is
  'Historique prive des signalements et de leur decision de moderation.';

revoke all on table public.signalement_moderation_audit from public, anon, authenticated;
revoke all on function public.tracer_moderation_groupe() from public, anon, authenticated;
revoke all on function public.mes_signalements(uuid, integer) from public, anon, authenticated;
grant execute on function public.mes_signalements(uuid, integer) to service_role;
