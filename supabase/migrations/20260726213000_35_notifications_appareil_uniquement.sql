-- =====================================================================
--  NOTIFICATIONS SUR APPAREIL UNIQUEMENT
-- ---------------------------------------------------------------------
--  Le produit retire temporairement les canaux e-mail et Telegram.
--  Cette migration :
--    1. clôt les envois encore en attente pour ces canaux ;
--    2. supprime leurs destinations personnelles ;
--    3. retire les secrets devenus inutiles ;
--    4. empêche toute réactivation hors de l'API.
--
--  Les migrations historiques restent immuables. Une réintroduction future
--  devra passer par une nouvelle migration explicite.
-- =====================================================================

update public.alertes a
   set statut = 'echec',
       erreur = 'canal retire : notifications sur appareil uniquement'
  from public.canaux c
 where c.id = a.canal_id
   and c.type in ('email', 'telegram')
   and a.statut = 'en_attente';

delete from public.canaux
 where type in ('email', 'telegram');

update public.abonnes
   set email = null
 where email is not null;

delete from public.config
 where k in ('smtp', 'telegram_token', 'telegram_bot_nom', 'telegram_webhook_secret');

alter table public.canaux
  drop constraint if exists canaux_appareil_uniquement;

alter table public.canaux
  add constraint canaux_appareil_uniquement
  check (type = 'webpush');

comment on constraint canaux_appareil_uniquement on public.canaux is
  'Seules les notifications Web Push produites par un appareil sont autorisees.';
