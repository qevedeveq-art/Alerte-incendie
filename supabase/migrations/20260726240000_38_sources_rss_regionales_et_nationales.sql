-- =====================================================================
--  CATALOGUE DES FLUX RSS REGIONAUX ET NATIONAUX (MIGRATION 38)
-- ---------------------------------------------------------------------
--  Insère le catalogue initial des flux officiels et médias régionaux
--  pour l'enrichissement des actualités locales vérifiées.
--
--  Mode initial : 'shadow' (actif = true) pour collecte sécurisée sans alerte.
--  INVARIANT INVIOLABLE : Le contexte ne modifie ni score, ni sévérité,
--  et n'impacte pas les calculs de quorum.
-- =====================================================================

insert into public.sources_contexte (code, nom, type, url_flux, licence, attribution, mode, actif)
values
  -- Sources nationales & officielles
  ('FR_MIN_INTERIEUR', 'Ministère de l’Intérieur - Sécurité Civile', 'autorite', 'https://www.interieur.gouv.fr/rss/feed/presse', 'Licence Ouverte v2.0', 'Gouvernement Français', 'shadow', true),
  ('FR_METEO_FORETS', 'Météo-France - Dossiers & Prévention', 'autorite', 'https://meteofrance.com/rss/dossiers-de-presse', 'Licence Ouverte v2.0', 'Météo-France', 'shadow', true),
  ('FR_PREVENTION_FORET', 'ONF - Office National des Forêts', 'autorite', 'https://www.onf.fr/onf/+/feed/rss.xml', 'Public Domain', 'ONF', 'shadow', true),
  ('FR_EFFIS_NEWS', 'Copernicus EFFIS - Situation Incendies Europe', 'partenaire', 'https://forest-fire.emergency.copernicus.eu/rss/news.xml', 'Copernicus Open Data', 'Copernicus EMS', 'shadow', true),

  -- Médias régionaux - Zone Méditerranée (PACA, Occitanie, Corse)
  ('FR_VAR_MATIN', 'Var-Matin / Nice-Matin Actualités', 'media', 'https://www.varmatin.com/rss', 'Presse Régionale', 'Var-Matin', 'shadow', true),
  ('FR_MIDILIBRE', 'Midi Libre Occitanie', 'media', 'https://www.midilibre.fr/rss.xml', 'Presse Régionale', 'Midi Libre', 'shadow', true),
  ('FR_INDEPENDANT', 'L’Indépendant Pyrénées-Orientales / Aude', 'media', 'https://www.lindependant.fr/rss.xml', 'Presse Régionale', 'L’Indépendant', 'shadow', true),
  ('FR_CORSE_MATIN', 'Corse-Matin Actualités', 'media', 'https://www.corsematin.com/rss.xml', 'Presse Régionale', 'Corse-Matin', 'shadow', true),
  ('FR_LAMARSEILLAISE', 'La Marseillaise Sud', 'media', 'https://www.lamarseillaise.fr/rss', 'Presse Régionale', 'La Marseillaise', 'shadow', true),

  -- Médias régionaux - Zone Sud-Ouest & Aquitaine
  ('FR_SUD_OUEST', 'Sud Ouest Régional', 'media', 'https://www.sudouest.fr/rss.xml', 'Presse Régionale', 'Sud Ouest', 'shadow', true),

  -- Médias régionaux - Zone Rhône-Alpes & Auvergne
  ('FR_LE_PROGRES', 'Le Progrès Rhône-Alpes', 'media', 'https://www.leprogres.fr/rss', 'Presse Régionale', 'Le Progrès', 'shadow', true),
  ('FR_DAUPHINE', 'Le Dauphiné Libéré', 'media', 'https://www.ledauphine.com/rss', 'Presse Régionale', 'Le Dauphiné Libéré', 'shadow', true),

  -- Fil d'actualité national & régional
  ('FR_FRANCE_BLEU', 'France Bleu Actu Régionale', 'media', 'https://www.francebleu.fr/rss/toute-l-actu.xml', 'Audiovisuel Public', 'Radio France', 'shadow', true),
  ('FR_FRANCE3_REGIONS', 'France 3 Régions', 'media', 'https://france3-regions.francetvinfo.fr/rss.xml', 'Audiovisuel Public', 'France Télévisions', 'shadow', true)

on conflict (code) do update set
  nom = excluded.nom,
  type = excluded.type,
  url_flux = excluded.url_flux,
  licence = excluded.licence,
  attribution = excluded.attribution,
  mode = excluded.mode,
  actif = excluded.actif,
  updated_at = now();
