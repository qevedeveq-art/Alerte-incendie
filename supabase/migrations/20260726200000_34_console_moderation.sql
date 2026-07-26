-- Console de moderation : lecture agregee et decisions humaines tracees.
-- Ces RPC restent exclusivement accessibles au service_role ; l'Edge Function
-- applique l'authentification administrateur et journalise chaque appel.

create function public.moderation_signalements(p_limite integer default 100)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', g.id,
    'lat', st_y(g.centre::geometry),
    'lon', st_x(g.centre::geometry),
    'commune', g.commune_nom,
    'natures', g.natures,
    'nb_signalements', g.nb,
    'nb_personnes', g.nb_personnes,
    'nb_reseaux', g.nb_reseaux,
    'confirme', g.confirme,
    'statut', g.statut,
    'moderation_statut', g.moderation_statut,
    'moderation_motif', g.moderation_motif,
    'premier_at', g.premier_at,
    'dernier_at', g.dernier_at,
    'moderation_updated_at', g.moderation_updated_at
  ) order by
    case g.moderation_statut when 'en_attente' then 0 else 1 end,
    g.dernier_at desc), '[]'::jsonb)
  from (
    select *
    from public.signalement_groupes
    where dernier_at > now() - interval '30 days'
    order by
      case moderation_statut when 'en_attente' then 0 else 1 end,
      dernier_at desc
    limit least(greatest(coalesce(p_limite, 100), 1), 200)
  ) g
$$;

create function public.moderer_signalement(
  p_groupe uuid,
  p_decision text,
  p_motif text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_avant text;
  v_apres text;
begin
  if p_decision not in ('rejeter', 'expirer', 'maintenir') then
    return jsonb_build_object('ok', false, 'erreur', 'decision invalide');
  end if;
  if length(trim(coalesce(p_motif, ''))) < 5 then
    return jsonb_build_object('ok', false, 'erreur', 'motif obligatoire');
  end if;

  select moderation_statut into v_avant
  from public.signalement_groupes
  where id = p_groupe
  for update;
  if not found then
    return jsonb_build_object('ok', false, 'erreur', 'groupe introuvable');
  end if;

  if p_decision = 'rejeter' then
    update public.signalement_groupes
       set statut = 'rejete', moderation_motif = left(trim(p_motif), 500)
     where id = p_groupe;
  elsif p_decision = 'expirer' then
    update public.signalement_groupes
       set statut = 'clos', moderation_motif = left(trim(p_motif), 500)
     where id = p_groupe;
  else
    update public.signalement_groupes
       set moderation_motif = left(trim(p_motif), 500)
     where id = p_groupe;
  end if;

  select moderation_statut into v_apres
  from public.signalement_groupes
  where id = p_groupe;

  insert into public.signalement_moderation_audit (
    groupe_id, ancien_statut, nouveau_statut, motif, origine
  ) values (
    p_groupe, v_avant, v_apres, left(trim(p_motif), 500), 'moderateur'
  );

  return jsonb_build_object('ok', true, 'statut', v_apres);
end;
$$;

comment on function public.moderation_signalements(integer) is
  'File de moderation agregee, sans identite, IP ni canal de contributeur.';
comment on function public.moderer_signalement(uuid, text, text) is
  'Decision moderateur motivee et journalisee ; ne permet pas de fabriquer une corroboration.';

revoke all on function public.moderation_signalements(integer) from public, anon, authenticated;
revoke all on function public.moderer_signalement(uuid, text, text) from public, anon, authenticated;
grant execute on function public.moderation_signalements(integer) to service_role;
grant execute on function public.moderer_signalement(uuid, text, text) to service_role;
