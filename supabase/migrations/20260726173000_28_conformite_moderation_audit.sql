-- ===================================================================
--  CONFORMITE, AUDIT ADMINISTRATEUR ET MODERATION CITOYENNE
-- ---------------------------------------------------------------------
--  Cette migration ne réintroduit pas l'ancien interrupteur d'homme
--  mort. Elle ferme trois lacunes distinctes relevées par l'audit :
--    - consentement versionné et droits d'accès/effacement ;
--    - journal des appels effectués avec admin_key ;
--    - contestation collective d'un faux signalement.
-- ===================================================================

alter table public.abonnes
  add column if not exists conditions_version text,
  add column if not exists conditions_acceptees_at timestamptz;

comment on column public.abonnes.conditions_version is
  'Version des informations et conditions explicitement acceptées à l''inscription.';

insert into public.config (k, v)
values (
  'telegram_webhook_secret',
  to_jsonb(encode(extensions.gen_random_bytes(32), 'hex'))
)
on conflict (k) do nothing;

insert into public.config (k, v)
values
  ('responsable_traitement', to_jsonb('qevedeveq@gmail.com'::text)),
  ('contact_rgpd', to_jsonb('qevedeveq@gmail.com'::text))
on conflict (k) do update set v = excluded.v;

create table if not exists public.audit_admin (
  id          bigserial primary key,
  action      text not null,
  ip_hash     text,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index if not exists audit_admin_created_idx on public.audit_admin (created_at desc);
alter table public.audit_admin enable row level security;

comment on table public.audit_admin is
  'Journal minimal des opérations authentifiées par admin_key. L''IP est hachée avec le sel applicatif.';

create table if not exists public.signalement_contestations (
  id          uuid primary key default gen_random_uuid(),
  groupe_id   uuid not null references public.signalement_groupes(id) on delete cascade,
  abonne_id   uuid not null references public.abonnes(id) on delete cascade,
  ip_hash     text,
  motif       text check (motif is null or length(motif) <= 160),
  created_at  timestamptz not null default now(),
  unique (groupe_id, abonne_id)
);
create index if not exists signalement_contestations_groupe_idx
  on public.signalement_contestations (groupe_id);
alter table public.signalement_contestations enable row level security;

comment on table public.signalement_contestations is
  'Contestations d''un signalement citoyen. Même seuil que la confirmation : deux réseaux ou trois personnes.';

create or replace function public.contester_signalement(
  p_abonne uuid,
  p_groupe uuid,
  p_ip text default null,
  p_motif text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_grp public.signalement_groupes;
  v_sel text; v_hash text;
  v_personnes integer; v_reseaux integer;
  v_inseree integer;
begin
  select * into v_grp
    from public.signalement_groupes
   where id = p_groupe;

  if v_grp.id is null then
    return jsonb_build_object('ok', false, 'erreur', 'signalement introuvable');
  end if;
  if v_grp.statut <> 'actif' then
    return jsonb_build_object('ok', true, 'deja_traite', true, 'statut', v_grp.statut);
  end if;
  if exists (
    select 1 from public.signalements
     where groupe_id = p_groupe and abonne_id = p_abonne
  ) then
    return jsonb_build_object(
      'ok', false, 'erreur', 'vous ne pouvez pas contester votre propre signalement');
  end if;

  select v #>> '{}' into v_sel from public.config where k = 'sel_ip';
  v_hash := case when p_ip is null then null
                 else encode(extensions.digest(p_ip || coalesce(v_sel, ''), 'sha256'), 'hex') end;

  insert into public.signalement_contestations (groupe_id, abonne_id, ip_hash, motif)
  values (p_groupe, p_abonne, v_hash, nullif(left(btrim(coalesce(p_motif, '')), 160), ''))
  on conflict (groupe_id, abonne_id) do nothing;
  get diagnostics v_inseree = row_count;

  select count(distinct abonne_id), count(distinct ip_hash)
    into v_personnes, v_reseaux
    from public.signalement_contestations
   where groupe_id = p_groupe;

  if public.signalement_confirmable(v_personnes, v_reseaux) then
    update public.signalement_groupes
       set statut = 'rejete', confirme = false, evenement_id = null
     where id = p_groupe;
    update public.signalements
       set statut = 'rejete'
     where groupe_id = p_groupe and statut = 'actif';

    -- Une preuve satellite reste valide même si la preuve citoyenne est
    -- retirée. Un événement exclusivement citoyen est en revanche clos.
    update public.evenements
       set statut = 'clos', clos_at = now()
     where id = v_grp.evenement_id and origine = 'citoyen' and statut = 'actif';

    update public.evenements
       set origine = 'satellite',
           sources = array_remove(sources, 'CITOYEN'),
           nb_signalements = 0,
           severite = public.calc_severite(
             public.sensibilite_effective(zone_id),
             nb_detections,
             frp_max,
             (select max(coalesce(d.confiance_num, 0))
                from public.detections d
                join public.evenement_detections ed on ed.detection_id = d.id
               where ed.evenement_id = v_grp.evenement_id),
             dans_commune,
             cardinality(array_remove(sources, 'CITOYEN')),
             resolution_min_m)
     where id = v_grp.evenement_id and origine = 'mixte';

    return jsonb_build_object(
      'ok', true, 'rejete', true,
      'contestataires', v_personnes, 'reseaux', v_reseaux);
  end if;

  return jsonb_build_object(
    'ok', true, 'rejete', false, 'deja_conteste', v_inseree = 0,
    'contestataires', v_personnes, 'reseaux', v_reseaux);
end;
$$;

create or replace function public.fiabilite_abonne(p_abonne uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'signalements',
      count(*) filter (where s.abonne_id = p_abonne),
    'confirmes',
      count(*) filter (where s.abonne_id = p_abonne and g.confirme),
    'corrobores',
      count(*) filter (
        where s.abonne_id = p_abonne
          and e.origine = 'mixte'),
    'rejetes',
      count(*) filter (
        where s.abonne_id = p_abonne
          and g.statut = 'rejete')
  )
  from public.signalements s
  left join public.signalement_groupes g on g.id = s.groupe_id
  left join public.evenements e on e.id = g.evenement_id;
$$;

create or replace function public.supprimer_abonne(p_abonne uuid)
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_groupes uuid[];
  v_groupes_contestes uuid[];
  v_zones uuid[];
  v_groupe uuid;
  v_grp public.signalement_groupes;
  v_personnes integer;
  v_reseaux integer;
begin
  select coalesce(array_agg(distinct groupe_id) filter (where groupe_id is not null), '{}')
    into v_groupes
    from public.signalements
   where abonne_id = p_abonne;
  select coalesce(array_agg(zone_id), '{}')
    into v_zones
    from public.zone_abonnes
   where abonne_id = p_abonne;
  select coalesce(array_agg(distinct groupe_id), '{}')
    into v_groupes_contestes
    from public.signalement_contestations
   where abonne_id = p_abonne;

  delete from public.abonnes where id = p_abonne;
  if not found then
    return jsonb_build_object('ok', false, 'erreur', 'abonne introuvable');
  end if;

  foreach v_groupe in array v_groupes
  loop
    v_grp := null;
    select count(distinct abonne_id), count(distinct ip_hash)
      into v_personnes, v_reseaux
      from public.signalements
     where groupe_id = v_groupe and statut = 'actif';

    update public.signalement_groupes
       set nb = v_personnes,
           nb_personnes = v_personnes,
           nb_reseaux = v_reseaux,
           confirme = public.signalement_confirmable(v_personnes, v_reseaux),
           statut = case when v_personnes = 0 then 'clos' else statut end
     where id = v_groupe
    returning * into v_grp;

    if v_grp.id is not null and not public.signalement_confirmable(v_personnes, v_reseaux) then
      update public.signalement_groupes
         set evenement_id = null
       where id = v_groupe;
      update public.evenements
         set statut = 'clos', clos_at = now()
       where id = v_grp.evenement_id and origine = 'citoyen' and statut = 'actif';
      update public.evenements
         set origine = 'satellite',
             sources = array_remove(sources, 'CITOYEN'),
             nb_signalements = 0,
             severite = public.calc_severite(
               public.sensibilite_effective(zone_id),
               nb_detections,
               frp_max,
               (select max(coalesce(d.confiance_num, 0))
                  from public.detections d
                  join public.evenement_detections ed on ed.detection_id = d.id
                 where ed.evenement_id = v_grp.evenement_id),
               dans_commune,
               cardinality(array_remove(sources, 'CITOYEN')),
               resolution_min_m)
       where id = v_grp.evenement_id and origine = 'mixte';
    end if;
  end loop;

  -- Une contestation effacée ne doit pas continuer à faire foi. Si le quorum
  -- de rejet disparaît, on restaure les témoignages puis leur quorum propre.
  foreach v_groupe in array v_groupes_contestes
  loop
    v_grp := null;
    select count(distinct abonne_id), count(distinct ip_hash)
      into v_personnes, v_reseaux
      from public.signalement_contestations
     where groupe_id = v_groupe;

    if not public.signalement_confirmable(v_personnes, v_reseaux) then
      update public.signalements
         set statut = 'actif'
       where groupe_id = v_groupe and statut = 'rejete';

      select count(distinct abonne_id), count(distinct ip_hash)
        into v_personnes, v_reseaux
        from public.signalements
       where groupe_id = v_groupe and statut = 'actif';

      update public.signalement_groupes
         set nb = v_personnes,
             nb_personnes = v_personnes,
             nb_reseaux = v_reseaux,
             confirme = public.signalement_confirmable(v_personnes, v_reseaux),
             confirme_at = case
               when public.signalement_confirmable(v_personnes, v_reseaux) then now()
               else null
             end,
             statut = case when v_personnes = 0 then 'clos' else 'actif' end,
             evenement_id = null
       where id = v_groupe
      returning * into v_grp;

      if v_grp.id is not null and v_grp.confirme then
        perform public.promouvoir_signalement(v_groupe);
      end if;
    end if;
  end loop;

  update public.zones z
     set actif = false
   where z.id = any(v_zones)
     and not exists (select 1 from public.zone_abonnes za where za.zone_id = z.id);

  delete from public.quotas
   where right(cle, length(p_abonne::text) + 1) = ':' || p_abonne::text;

  return jsonb_build_object(
    'ok', true,
    'groupes_recalcules', cardinality(v_groupes),
    'contestations_recalculees', cardinality(v_groupes_contestes));
end;
$$;

-- La purge centralise aussi les nouvelles données personnelles. Les
-- signalements sont supprimés avant leurs groupes car les premières versions
-- du schéma n'avaient volontairement pas de clé étrangère sur groupe_id.
create or replace function public.purger()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_perimees integer;
begin
  select public.perimer_alertes() into v_perimees;
  delete from public.detections where acq_ts < now() - interval '90 days';
  delete from public.evenements where statut = 'clos' and clos_at < now() - interval '365 days';
  delete from public.signalements where created_at < now() - interval '365 days';
  delete from public.signalement_groupes
   where statut in ('clos', 'rejete') and dernier_at < now() - interval '365 days';
  delete from public.observations_aero where vu_at < now() - interval '24 hours';
  delete from public.runs where started_at < now() - interval '30 days';
  delete from public.audit_admin where created_at < now() - interval '180 days';
  delete from public.alertes where created_at < now() - interval '180 days';
  delete from public.quotas where fenetre < now() - interval '2 days';
  delete from public.creneaux_traites where traite_at < now() - interval '7 days';
  delete from public.meteo m
   where not exists (select 1 from public.zones z where z.id = m.zone_id);
  delete from public.abonnes a
   where coalesce(a.last_seen_at, a.created_at) < now() - interval '60 days'
     and not exists (select 1 from public.canaux c where c.abonne_id = a.id)
     and not exists (select 1 from public.zone_abonnes z where z.abonne_id = a.id);
  return jsonb_build_object('alertes_perimees', v_perimees);
end;
$$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
revoke all on all tables in schema public from anon, authenticated;
