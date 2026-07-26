-- ===================================================================
--  REPRISE SUR ECHEC D'ENVOI
-- ---------------------------------------------------------------------
--  Bug corrige ici : dispatch selectionnait la file avec
--  `tentatives < 4` mais ecrivait `tentatives = 4` des le premier
--  echec, tout en laissant `statut = 'en_attente'`. Consequence :
--
--    - un hoquet SMTP ou un 502 Telegram perdait l'alerte en silence,
--      sans jamais la rejouer ;
--    - la ligne restait 'en_attente' indefiniment, donc poll-firms
--      voyait en permanence des alertes en attente et rappelait
--      dispatch toutes les 10 minutes pour ne rien faire.
--
--  On introduit un vrai reessai avec temporisation croissante, et une
--  peremption : une alerte incendie vieille de plus de 2 h n'est plus
--  une alerte, c'est de la desinformation. On ne l'envoie pas.
-- ===================================================================

alter table public.alertes
  add column if not exists prochaine_tentative_at timestamptz not null default now();

comment on column public.alertes.prochaine_tentative_at is
  'Date a partir de laquelle dispatch peut retenter l''envoi (temporisation exponentielle).';

create index if not exists alertes_file_pret_idx
  on public.alertes (prochaine_tentative_at)
  where statut = 'en_attente';

-- ---------------------------------------------------------------------
--  L'index d'unicite ignorait le type : une alerte de fin d'evenement
--  serait entree en conflit avec l'alerte d'origine (meme evenement,
--  meme canal, meme severite) et aurait ete silencieusement rejetee.
-- ---------------------------------------------------------------------
drop index if exists public.alertes_unicite_idx;
create unique index alertes_unicite_idx
  on public.alertes (evenement_id, canal_id, severite, type)
  where evenement_id is not null;

-- ---------------------------------------------------------------------
--  Reparation des lignes bloquees par le bug.
--  Les recentes sont rejouables ; les anciennes sont perimees et sont
--  closes explicitement, pour ne pas reveiller des alertes obsoletes
--  au premier passage du dispatch corrige.
-- ---------------------------------------------------------------------
update public.alertes
   set statut = 'echec',
       erreur = coalesce(erreur, '') || ' [perimee, jamais rejouee : bug de reprise]'
 where statut = 'en_attente'
   and tentatives >= 4
   and created_at < now() - interval '2 hours';

update public.alertes
   set tentatives = 0, prochaine_tentative_at = now(), erreur = null
 where statut = 'en_attente'
   and tentatives >= 4
   and created_at >= now() - interval '2 hours';

-- ---------------------------------------------------------------------
--  File prete a l'envoi : ce que dispatch doit consommer.
--  Centralise ici plutot que dans le client TypeScript, pour que la
--  regle de peremption et de temporisation soit unique et testable.
-- ---------------------------------------------------------------------
create or replace function public.alertes_a_envoyer(p_limite integer default 200)
returns setof public.alertes
language sql stable security definer set search_path = public, extensions
as $$
  select *
    from public.alertes
   where statut = 'en_attente'
     and tentatives < 5
     and prochaine_tentative_at <= now()
     -- une alerte incendie perimee n'est pas envoyee ; les autres types
     -- (test, code de confirmation, heartbeat) restent valables plus longtemps
     and created_at > now() - case when type = 'alerte'
                                   then interval '2 hours'
                                   else interval '24 hours' end
   order by
     case severite when 'critique' then 0 when 'alerte' then 1 else 2 end,
     created_at
   limit greatest(1, least(p_limite, 500));
$$;

-- ---------------------------------------------------------------------
--  Perime les alertes que le dispatch ne prendra plus, pour que
--  `alertes_en_attente` de v_sante redevienne un indicateur honnete.
-- ---------------------------------------------------------------------
create or replace function public.perimer_alertes()
returns integer
language sql security definer set search_path = public, extensions
as $$
  with p as (
    update public.alertes
       set statut = 'echec',
           erreur = coalesce(erreur, 'perimee avant envoi')
     where statut = 'en_attente'
       and (tentatives >= 5
            or created_at < now() - case when type = 'alerte'
                                         then interval '2 hours'
                                         else interval '24 hours' end)
    returning 1)
  select count(*)::integer from p;
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
