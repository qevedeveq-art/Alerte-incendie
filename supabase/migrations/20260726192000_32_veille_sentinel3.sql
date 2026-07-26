-- Veille mensuelle declarative sur l'exposition STAC de Sentinel-3 FRP NRT.
select cron.unschedule(jobname)
from cron.job
where jobname = 'probe-sentinel3';

select cron.schedule('probe-sentinel3', '45 4 1 * *',
  $$select public.appeler_fonction('probe-sentinel3')$$);
