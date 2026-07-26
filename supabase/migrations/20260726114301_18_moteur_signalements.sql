-- ===================================================================
--  MOTEUR DES SIGNALEMENTS
-- ===================================================================

-- Rayon de regroupement : 50 m, comme demande. Fenetre de 6 h : au-dela,
-- deux signalements au meme endroit sont deux evenements differents.
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

  -- Groupe existant a moins de 50 m et de moins de 6 h ?
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

  -- Cet abonne a-t-il deja signale ce groupe ?
  select exists (
    select 1 from public.signalements s
     where s.groupe_id = v_grp.id and s.abonne_id = p_abonne and s.statut = 'actif'
  ) into v_deja;

  if v_deja then
    return jsonb_build_object(
      'ok', true, 'deja_signale', true, 'groupe_id', v_grp.id,
      'confirme', v_grp.confirme, 'nb_personnes', v_grp.nb_personnes,
      'message', 'Vous avez deja signale ce depart de feu. Il faut une autre personne pour le confirmer.');
  end if;

  insert into public.signalements (
    abonne_id, groupe_id, geom, lat, lon, nature, commentaire, ip_hash,
    commune_code, commune_nom)
  values (p_abonne, v_grp.id, v_geom, p_lat, p_lon, p_nature,
          nullif(btrim(coalesce(p_commentaire, '')), ''), v_hash,
          v_com.code, v_com.nom)
  returning id into v_sig;

  -- Recomptage : personnes et reseaux distincts. Les deux doivent atteindre 2,
  -- ce qui empeche l'auto-confirmation depuis deux appareils du meme reseau.
  select count(*), count(distinct abonne_id), count(distinct ip_hash)
    into v_nb, v_pers, v_res
  from public.signalements
   where groupe_id = v_grp.id and statut = 'actif';

  update public.signalement_groupes g
     set nb = v_nb,
         nb_personnes = v_pers,
         nb_reseaux = v_res,
         natures = (select array_agg(distinct n) from unnest(g.natures || p_nature) n),
         centre = (select st_centroid(st_collect(s.geom::geometry))::geography
                     from public.signalements s
                    where s.groupe_id = g.id and s.statut = 'actif'),
         commune_code = coalesce(g.commune_code, v_com.code),
         commune_nom = coalesce(g.commune_nom, v_com.nom),
         dernier_at = now()
   where g.id = v_grp.id
  returning * into v_grp;

  if not v_grp.confirme and v_pers >= 2 and v_res >= 2 then
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
    'message', case when v_grp.confirme
      then 'Signalement confirme par plusieurs personnes. Les abonnes du secteur sont prevenus.'
      else 'Signalement enregistre. Il sera confirme si une autre personne signale le meme depart de feu.' end);
end;
$$;

-- ===================================================================
--  Promotion d'un groupe confirme en evenement notifiable
--  Severite plafonnee a 'alerte' : un signalement citoyen, meme
--  confirme, n'est pas une preuve de meme classe qu'une detection
--  satellite. Il passera en 'critique' si un satellite corrobore.
-- ===================================================================
create or replace function public.promouvoir_signalement(p_groupe uuid)
returns uuid
language plpgsql security definer set search_path = public, extensions
as $$
declare
  g public.signalement_groupes; z record; evt public.evenements;
  v_dist integer; v_dans boolean; v_id uuid;
begin
  select * into g from public.signalement_groupes where id = p_groupe;
  if g is null or not g.confirme then return null; end if;
  if g.evenement_id is not null then return g.evenement_id; end if;

  -- Une zone surveillee couvre-t-elle ce point ?
  for z in
    select * from public.zones
    where actif and geom is not null and st_intersects(geom, g.centre)
  loop
    v_dans := (g.commune_code is not null and g.commune_code = z.commune_code);
    select round(st_distance(g.centre, c.centre))::integer into v_dist
      from public.communes c where c.code = z.commune_code;

    -- Rattachement a un evenement satellite proche : c'est le cas le plus
    -- fiable, le terrain et l'espace disent la meme chose.
    select * into evt from public.evenements e
     where e.zone_id = z.id and e.statut = 'actif'
       and e.derniere_maj > now() - interval '12 hours'
       and st_dwithin(e.centre, g.centre, 2000)
     order by st_distance(e.centre, g.centre) limit 1;

    if evt.id is null then
      insert into public.evenements (
        zone_id, origine, severite, centre, nb_detections, sources,
        commune_code, commune_nom, dans_commune, distance_m, debut_ts, resolution_min_m)
      values (z.id, 'citoyen', 'alerte', g.centre, g.nb, array['CITOYEN'],
              g.commune_code, g.commune_nom, coalesce(v_dans, false), v_dist,
              g.premier_at, 50)
      returning * into evt;
    else
      -- Le satellite avait deja vu : la concordance justifie 'critique'
      update public.evenements e
         set origine = case when e.origine = 'satellite' then 'mixte' else e.origine end,
             sources = (select array_agg(distinct s) from unnest(e.sources || 'CITOYEN') s),
             severite = case when e.origine = 'satellite' then 'critique' else e.severite end,
             derniere_maj = now()
       where e.id = evt.id
      returning * into evt;
    end if;

    update public.signalement_groupes set evenement_id = evt.id where id = g.id;
    v_id := evt.id;
    perform public.mettre_en_file_alertes(evt.id);
  end loop;

  return v_id;
end;
$$;

-- Cloture des groupes sans nouveau signalement depuis 12 h
create or replace function public.clore_signalements()
returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.signalement_groupes
     set statut = 'clos'
   where statut = 'actif' and dernier_at < now() - interval '12 hours';
  get diagnostics n = row_count;
  update public.signalements s set statut = 'clos'
   where s.statut = 'actif'
     and exists (select 1 from public.signalement_groupes g
                  where g.id = s.groupe_id and g.statut = 'clos');
  return n;
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
revoke all on all tables in schema public from anon, authenticated;;