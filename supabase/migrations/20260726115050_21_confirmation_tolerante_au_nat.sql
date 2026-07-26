-- ===================================================================
--  CONFIRMATION : ARBITRAGE ENTRE ABUS ET FAUX NEGATIFS
-- ---------------------------------------------------------------------
--  Exiger deux reseaux distincts bloquait l'auto-confirmation a deux
--  appareils. Mais cela bloquait aussi deux temoins legitimes partageant
--  une box, et surtout les abonnes mobiles : le NAT d'operateur fait
--  partager une meme IP publique a des milliers de personnes.
--
--  Or dans un vrai depart de feu, les deux premiers temoins sont tres
--  probablement voisins, donc sur le meme reseau. Le compromis retenu :
--
--    2 personnes sur 2 reseaux distincts  -> confirme
--    3 personnes, meme reseau             -> confirme
--
--  Un abuseur doit donc fabriquer trois comptes et passer trois fois le
--  quota horaire, au lieu de deux. Deux voisins de bonne foi restent
--  bloques une iteration, mais un troisieme temoin suffit.
-- ===================================================================
create or replace function public.signalement_confirmable(
  p_personnes integer, p_reseaux integer
) returns boolean
language sql immutable set search_path = '' as $$
  select (p_personnes >= 2 and p_reseaux >= 2) or p_personnes >= 3;
$$;

comment on function public.signalement_confirmable(integer,integer) is
  'Deux personnes sur deux reseaux distincts, ou trois personnes quel que soit le reseau. Tolere le NAT d''operateur sans ouvrir l''auto-confirmation a deux appareils.';

create or replace function public.enregistrer_signalement(
  p_abonne uuid,
  p_lat double precision,
  p_lon double precision,
  p_nature text default 'fumee',
  p_commentaire text default null,
  p_ip text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare
  v_geom geography; v_grp public.signalement_groupes;
  v_sel text; v_hash text; v_com record;
  v_sig uuid; v_deja boolean;
  v_nb integer; v_pers integer; v_res integer;
begin
  if p_lat is null or p_lon is null
     or p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    return jsonb_build_object('ok', false, 'erreur', 'coordonnees invalides');
  end if;

  v_geom := st_setsrid(st_point(p_lon, p_lat), 4326)::geography;

  select v #>> '{}' into v_sel from public.config where k = 'sel_ip';
  v_hash := case when p_ip is null then null
                 else encode(extensions.digest(p_ip || coalesce(v_sel, ''), 'sha256'), 'hex') end;

  select c.code, c.nom into v_com
    from public.communes c where st_intersects(c.geom, v_geom) limit 1;

  select * into v_grp from public.signalement_groupes g
   where g.statut = 'actif'
     and g.dernier_at > now() - interval '6 hours'
     and st_dwithin(g.centre, v_geom, 50)
   order by st_distance(g.centre, v_geom) limit 1;

  if v_grp.id is null then
    insert into public.signalement_groupes (centre, commune_code, commune_nom, natures)
    values (v_geom, v_com.code, v_com.nom, array[p_nature])
    returning * into v_grp;
  end if;

  select exists (
    select 1 from public.signalements s
     where s.groupe_id = v_grp.id and s.abonne_id = p_abonne and s.statut = 'actif'
  ) into v_deja;

  if v_deja then
    return jsonb_build_object(
      'ok', true, 'deja_signale', true, 'groupe_id', v_grp.id,
      'confirme', v_grp.confirme, 'nb_personnes', v_grp.nb_personnes,
      'message', 'Vous avez deja signale ce depart de feu.');
  end if;

  insert into public.signalements (
    abonne_id, groupe_id, geom, lat, lon, nature, commentaire, ip_hash,
    commune_code, commune_nom)
  values (p_abonne, v_grp.id, v_geom, p_lat, p_lon, p_nature,
          nullif(btrim(coalesce(p_commentaire, '')), ''), v_hash,
          v_com.code, v_com.nom)
  returning id into v_sig;

  select count(*), count(distinct abonne_id), count(distinct ip_hash)
    into v_nb, v_pers, v_res
  from public.signalements
   where groupe_id = v_grp.id and statut = 'actif';

  update public.signalement_groupes g
     set nb = v_nb, nb_personnes = v_pers, nb_reseaux = v_res,
         natures = (select array_agg(distinct n) from unnest(g.natures || p_nature) n),
         centre = (select st_centroid(st_collect(s.geom::geometry))::geography
                     from public.signalements s
                    where s.groupe_id = g.id and s.statut = 'actif'),
         commune_code = coalesce(g.commune_code, v_com.code),
         commune_nom = coalesce(g.commune_nom, v_com.nom),
         dernier_at = now()
   where g.id = v_grp.id
  returning * into v_grp;

  if not v_grp.confirme and public.signalement_confirmable(v_pers, v_res) then
    update public.signalement_groupes
       set confirme = true, confirme_at = now()
     where id = v_grp.id
    returning * into v_grp;
    perform public.promouvoir_signalement(v_grp.id);
  end if;

  return jsonb_build_object(
    'ok', true, 'signalement_id', v_sig, 'groupe_id', v_grp.id,
    'confirme', v_grp.confirme,
    'nb_personnes', v_grp.nb_personnes,
    'commune', v_grp.commune_nom,
    'message', case
      when v_grp.confirme then
        'Signalement confirme par plusieurs personnes. Les abonnes du secteur sont prevenus.'
      when v_pers >= 2 then
        'Signalement enregistre. Vous etes ' || v_pers || ' a l avoir signale, mais depuis le meme reseau : '
        || 'une personne de plus, ou depuis une autre connexion, confirmera l alerte.'
      else
        'Signalement enregistre. Il sera confirme si une autre personne signale le meme depart de feu.'
    end);
end;
$$;

-- Rattrapage des groupes qui remplissent desormais le critere
do $$
declare g record;
begin
  for g in select id, nb_personnes, nb_reseaux from public.signalement_groupes
           where not confirme and statut = 'actif'
  loop
    if public.signalement_confirmable(g.nb_personnes, g.nb_reseaux) then
      update public.signalement_groupes set confirme = true, confirme_at = now() where id = g.id;
      perform public.promouvoir_signalement(g.id);
    end if;
  end loop;
end $$;

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