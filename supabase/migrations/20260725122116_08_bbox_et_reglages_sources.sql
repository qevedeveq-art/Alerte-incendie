-- Emprise globale des zones actives : sert a filtrer les flux satellite
-- (5000 lignes Europe -> quelques dizaines de lignes pertinentes).
create or replace function public.bbox_surveillance(p_marge_deg numeric default 0.05)
returns jsonb
language sql stable security definer set search_path = public, extensions
as $$
  select case when count(*) = 0 then null else jsonb_build_object(
    'ouest', min(st_xmin(g)) - p_marge_deg, 'sud',  min(st_ymin(g)) - p_marge_deg,
    'est',   max(st_xmax(g)) + p_marge_deg, 'nord', max(st_ymax(g)) + p_marge_deg) end
  from (select geom::geometry as g from public.zones where actif and geom is not null) s;
$$;

-- Confirmation des sources permanentes : deux regimes, pour etre operationnel
-- des la 2e semaine sans risquer de museler un vrai feu de longue duree.
create or replace function public.apprendre_sources_permanentes()
returns integer
language plpgsql security definer set search_path = public, extensions
as $$
declare n integer;
begin
  insert into public.sources_permanentes (cell, geom, occurrences, jours_actifs, first_seen, last_seen)
  select cell,
         st_setsrid(st_point(avg(lon), avg(lat)), 4326)::geography,
         count(*), count(distinct acq_ts::date), min(acq_ts), max(acq_ts)
  from (
    select round(lat / 0.005) || '_' || round(lon / 0.005) as cell, lat, lon, acq_ts
    from public.detections
    where ingested_at > now() - interval '2 hours'
  ) s
  group by cell
  on conflict (cell) do update
    set occurrences  = public.sources_permanentes.occurrences + excluded.occurrences,
        jours_actifs = public.sources_permanentes.jours_actifs
                       + (case when excluded.last_seen::date > public.sources_permanentes.last_seen::date then 1 else 0 end),
        last_seen    = greatest(public.sources_permanentes.last_seen, excluded.last_seen);

  update public.sources_permanentes
     set confirmee = true,
         note = coalesce(note, 'auto : source thermique recurrente')
   where not confirmee
     and (
       -- regime long : signature industrielle indiscutable
       (jours_actifs >= 8 and last_seen - first_seen >= interval '30 days')
       -- regime court : 5 jours distincts sur 10 jours = pas un feu de foret
       or (jours_actifs >= 5 and last_seen - first_seen >= interval '10 days')
     );

  update public.detections d
     set permanente = true
   from public.sources_permanentes sp
  where sp.confirmee and not d.permanente
    and d.ingested_at > now() - interval '2 hours'
    and st_dwithin(d.geom, sp.geom, 400);

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Purge : garde 90 jours de detections, 1 an d'evenements
create or replace function public.purger()
returns void language sql security definer set search_path = public as $$
  delete from public.detections where acq_ts < now() - interval '90 days';
  delete from public.evenements where statut = 'clos' and clos_at < now() - interval '365 days';
  delete from public.runs where started_at < now() - interval '30 days';
  delete from public.alertes where created_at < now() - interval '180 days';
$$;;