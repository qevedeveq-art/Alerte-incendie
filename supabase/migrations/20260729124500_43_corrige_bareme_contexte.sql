-- Corrige la construction du tableau de raisons du barème de contexte.
-- L'opérateur text[] || text est ambigu pour PostgreSQL : array_append
-- exprime explicitement l'ajout d'un élément.

create or replace function public.score_association_contexte(
  p_texte_normalise text,
  p_commune_evenement text,
  p_limitrophe boolean,
  p_ecart_heures numeric,
  p_distance_m numeric,
  p_rayon_m numeric default 2000
)
returns jsonb
language plpgsql
stable
set search_path = public, extensions
as $$
declare
  v_score integer := 0;
  v_raisons text[] := '{}';
  v_mots_feu text[] := array[
    'incendie', 'feu ', 'feux', 'flamme', 'fumee', 'brasier',
    'sdis', 'pompier', 'canadair', 'sinistre', 'hectare'
  ];
  v_mots_negation text[] := array[
    'exercice', 'entrainement', 'simulation', 'simule', 'fiction',
    'anniversaire', 'commemoration', 'archive', 'il y a un an',
    'prevention', 'campagne de sensibilisation', 'reconstitution'
  ];
  v_mot text;
begin
  if p_distance_m is not null and p_distance_m <= coalesce(p_rayon_m, 2000) + 1000 then
    v_score := v_score + 45;
    v_raisons := array_append(
      v_raisons,
      'Coordonnee dans le rayon d incertitude majore de 1 km'
    );
  elsif public.toponyme_present(p_texte_normalise, p_commune_evenement) then
    v_score := v_score + 35;
    v_raisons := array_append(
      v_raisons,
      'Commune exacte reconnue : ' || p_commune_evenement
    );
  elsif coalesce(p_limitrophe, false) then
    v_score := v_score + 15;
    v_raisons := array_append(v_raisons, 'Commune limitrophe reconnue');
  end if;

  if p_ecart_heures is not null then
    if p_ecart_heures <= 2 then
      v_score := v_score + 25;
      v_raisons := array_append(
        v_raisons,
        'Publication a moins de 2 h de l observation'
      );
    elsif p_ecart_heures <= 6 then
      v_score := v_score + 18;
      v_raisons := array_append(v_raisons, 'Publication a moins de 6 h');
    elsif p_ecart_heures <= 24 then
      v_score := v_score + 8;
      v_raisons := array_append(v_raisons, 'Publication a moins de 24 h');
    end if;
  end if;

  foreach v_mot in array v_mots_feu loop
    if position(v_mot in coalesce(p_texte_normalise, '')) > 0 then
      v_score := v_score + 10;
      v_raisons := array_append(v_raisons, 'Vocabulaire de feu actif coherent');
      exit;
    end if;
  end loop;

  foreach v_mot in array v_mots_negation loop
    if position(v_mot in coalesce(p_texte_normalise, '')) > 0 then
      v_score := v_score - 60;
      v_raisons := array_append(
        v_raisons,
        'Marqueur de negation detecte : ' || btrim(v_mot)
      );
      exit;
    end if;
  end loop;

  return jsonb_build_object(
    'score', greatest(0, least(100, v_score)),
    'raisons', to_jsonb(v_raisons)
  );
end;
$$;

comment on function public.score_association_contexte(
  text, text, boolean, numeric, numeric, numeric
) is
  'Bareme explicable du lien mention <-> evenement. Le type de source ne donne aucun point. Ne modifie aucune donnee.';

revoke all on function public.score_association_contexte(
  text, text, boolean, numeric, numeric, numeric
) from public, anon, authenticated;

grant execute on function public.score_association_contexte(
  text, text, boolean, numeric, numeric, numeric
) to service_role;
