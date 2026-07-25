-- ===================================================================
--  DURCISSEMENT DES DROITS
--  Postgres accorde EXECUTE a PUBLIC par defaut sur toute fonction :
--  un simple "revoke ... from anon, authenticated" ne suffit donc pas,
--  le droit herite de PUBLIC subsiste. Sans cela, purger() ou
--  appeler_fonction() etaient joignables via /rest/v1/rpc/ avec la
--  seule cle anon (publique par nature).
-- ===================================================================

alter default privileges in schema public revoke execute on functions from public;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

-- search_path fige sur les deux fonctions pures qui en manquaient
create or replace function public.severite_rang(s text)
returns integer language sql immutable
set search_path = ''
as $$ select case s when 'critique' then 3 when 'alerte' then 2 when 'info' then 1 else 0 end $$;

create or replace function public.calc_severite(
  p_sensibilite text, p_nb integer, p_frp_max numeric,
  p_conf_max integer, p_dans_commune boolean, p_nb_sources integer
) returns text
language sql immutable
set search_path = ''
as $$
  select case p_sensibilite
    when 'sensible' then
      case when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 or (p_dans_commune and coalesce(p_conf_max,0) >= 50)
             then 'critique' else 'alerte' end
    when 'conservateur' then
      case when p_nb >= 4 or coalesce(p_frp_max,0) >= 100 or p_nb_sources >= 2 then 'critique'
           when p_nb >= 2 or coalesce(p_frp_max,0) >= 25 then 'alerte'
           else 'info' end
    else
      case when p_nb >= 3 or coalesce(p_frp_max,0) >= 50 or p_nb_sources >= 2
                or (p_dans_commune and coalesce(p_conf_max,0) >= 50 and coalesce(p_frp_max,0) >= 10)
             then 'critique'
           when coalesce(p_conf_max,0) >= 50 then 'alerte'
           else 'info' end
  end;
$$;

revoke all on function public.severite_rang(text) from public, anon, authenticated;
revoke all on function public.calc_severite(text,integer,numeric,integer,boolean,integer)
  from public, anon, authenticated;
grant execute on function public.severite_rang(text) to service_role;
grant execute on function public.calc_severite(text,integer,numeric,integer,boolean,integer) to service_role;

-- Les tables restent en deny-all : aucune policy, aucun acces direct.
-- Toute lecture/ecriture passe par les Edge Functions (service role).
revoke all on all tables in schema public from anon, authenticated;
