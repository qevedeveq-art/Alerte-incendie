-- Corrige la concatenation scalaire/tableau de la migration 27.
-- L'ancienne expression provoquait "malformed array literal" lorsqu'une
-- corroboration aerienne etait trouvee.

create or replace function public.corroborer_par_aeronefs()
returns jsonb
language plpgsql security definer set search_path = public, extensions
as $$
declare e record; v_nb integer; v_maj integer := 0;
begin
  for e in
    select * from public.evenements
     where statut = 'actif'
       and derniere_maj > now() - interval '6 hours'
       and not ('ADSB' = any(sources))
  loop
    select coalesce(max(x.nb), 0)::integer
      into v_nb
      from (
        select count(*) as nb
          from public.observations_aero o
         where o.vu_at > now() - interval '30 minutes'
           and st_dwithin(o.geom, e.centre, 4000)
         group by o.icao24
      ) x;

    if v_nb >= 2 then
      update public.evenements
         set sources = (
               select array_agg(distinct s)
                 from unnest(array_append(sources, 'ADSB'::text)) s
             ),
             derniere_maj = now(),
             fin_notifiee_at = null
       where id = e.id;

      update public.evenements
         set severite = public.greatest_severite(severite, 'critique')
       where id = e.id;

      perform public.mettre_en_file_alertes(e.id);
      v_maj := v_maj + 1;
    end if;
  end loop;

  return jsonb_build_object('evenements_corrobores', v_maj);
end;
$$;
