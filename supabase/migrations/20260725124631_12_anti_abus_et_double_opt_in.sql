-- ===================================================================
--  ANTI-ABUS — indispensable avant toute ouverture au public
-- ---------------------------------------------------------------------
--  Faille corrigee : n'importe qui pouvait creer un abonne, y attacher
--  une adresse e-mail arbitraire et declencher un envoi. Le service
--  devenait un relais de spam gratuit, et l'IP d'envoi (Gmail de
--  l'exploitant) aurait ete blacklistee.
--
--  Reponse : double opt-in obligatoire sur l'e-mail, et quotas sur
--  toutes les routes ecrivant ou envoyant.
-- ===================================================================

-- ---------- double opt-in ----------
alter table public.canaux
  add column if not exists code_verif       text,
  add column if not exists code_expire_at   timestamptz,
  add column if not exists tentatives_verif smallint not null default 0,
  add column if not exists demandes_verif   smallint not null default 0;

comment on column public.canaux.verifie is
  'e-mail : exige la saisie du code recu. push : implicite (l''abonnement vient de l''appareil). telegram : implicite (le chat_id vient d''un /start de l''utilisateur).';

-- ---------- quotas ----------
create table if not exists public.quotas (
  cle        text        not null,
  fenetre    timestamptz not null,
  compteur   integer     not null default 0,
  primary key (cle, fenetre)
);
create index if not exists quotas_fenetre_idx on public.quotas (fenetre);
alter table public.quotas enable row level security;

-- Compteur a fenetre glissante discretisee. Renvoie false si le quota est
-- depasse : l'appelant refuse alors la requete.
create or replace function public.consommer_quota(
  p_cle text, p_max integer, p_fenetre interval
) returns boolean
language plpgsql security definer set search_path = public
as $$
declare v_debut timestamptz; v_n integer;
begin
  v_debut := to_timestamp(floor(extract(epoch from now()) / extract(epoch from p_fenetre))
                          * extract(epoch from p_fenetre));
  insert into public.quotas (cle, fenetre, compteur)
  values (p_cle, v_debut, 1)
  on conflict (cle, fenetre) do update set compteur = public.quotas.compteur + 1
  returning compteur into v_n;

  return v_n <= p_max;
end;
$$;

-- ---------- plafonds par abonne ----------
create or replace function public.verifier_plafonds(p_abonne uuid, p_quoi text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case p_quoi
    when 'zones'  then (select count(*) from public.zone_abonnes where abonne_id = p_abonne) < 10
    when 'canaux' then (select count(*) from public.canaux       where abonne_id = p_abonne) < 8
    else false end;
$$;

-- ---------- un e-mail non verifie ne recoit jamais d'alerte ----------
create or replace function public.mettre_en_file_alertes(p_evt_id uuid)
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare
  evt public.evenements; z public.zones;
  v_count integer := 0; r record;
  v_local time; v_silence boolean;
begin
  select * into evt from public.evenements where id = p_evt_id;
  if evt is null then return 0; end if;
  select * into z from public.zones where id = evt.zone_id;

  if evt.severite_notifiee is not null
     and public.severite_rang(evt.severite) <= public.severite_rang(evt.severite_notifiee) then
    return 0;
  end if;

  for r in
    select cx.id as canal_id, cx.type, ab.id as abonne_id, ab.seuil_min,
           ab.quiet_start, ab.quiet_end, ab.fuseau
      from public.zone_abonnes za
      join public.abonnes ab on ab.id = za.abonne_id and ab.actif
      join public.canaux  cx on cx.abonne_id = ab.id and cx.actif
     where za.zone_id = evt.zone_id
       -- un e-mail non confirme est ignore : anti-spam
       and (cx.type <> 'email' or cx.verifie)
  loop
    if public.severite_rang(evt.severite) < public.severite_rang(r.seuil_min) then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'sous le seuil de l abonne')
      on conflict do nothing;
      continue;
    end if;

    v_silence := false;
    if r.quiet_start is not null and r.quiet_end is not null and evt.severite <> 'critique' then
      v_local := (now() at time zone r.fuseau)::time;
      v_silence := case when r.quiet_start <= r.quiet_end
                        then v_local between r.quiet_start and r.quiet_end
                        else v_local >= r.quiet_start or v_local <= r.quiet_end end;
    end if;

    if v_silence then
      insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, motif_ignore)
      values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'ignore', 'heures silencieuses')
      on conflict do nothing;
      continue;
    end if;

    insert into public.alertes (evenement_id, canal_id, abonne_id, type, severite, statut, payload)
    values (p_evt_id, r.canal_id, r.abonne_id, 'alerte', evt.severite, 'en_attente',
            jsonb_build_object(
              'zone', z.nom, 'commune', coalesce(evt.commune_nom, z.nom),
              'dans_commune', evt.dans_commune, 'distance_m', evt.distance_m,
              'severite', evt.severite, 'nb_detections', evt.nb_detections,
              'frp_max', evt.frp_max, 'sources', evt.sources,
              'lat', st_y(evt.centre::geometry), 'lon', st_x(evt.centre::geometry),
              'debut_ts', evt.debut_ts, 'evenement_id', evt.id))
    on conflict do nothing;
    v_count := v_count + 1;
  end loop;

  update public.evenements set severite_notifiee = evt.severite where id = p_evt_id;
  return v_count;
end;
$$;

-- ---------- purge des quotas ----------
create or replace function public.purger()
returns void language sql security definer set search_path = public as $$
  delete from public.detections where acq_ts < now() - interval '90 days';
  delete from public.evenements where statut = 'clos' and clos_at < now() - interval '365 days';
  delete from public.runs    where started_at < now() - interval '30 days';
  delete from public.alertes where created_at < now() - interval '180 days';
  delete from public.quotas  where fenetre < now() - interval '2 days';
  -- abonne sans canal ni zone, inactif depuis 60 jours : on ne garde pas de donnees inutiles
  delete from public.abonnes a
   where coalesce(a.last_seen_at, a.created_at) < now() - interval '60 days'
     and not exists (select 1 from public.canaux c where c.abonne_id = a.id)
     and not exists (select 1 from public.zone_abonnes z where z.abonne_id = a.id);
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
revoke all on all tables in schema public from anon, authenticated;;