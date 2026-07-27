/* Configuration de déploiement de la PWA.
 * ---------------------------------------------------------------------
 * La référence du projet Supabase était écrite en dur dans trois pages.
 * Changer de projet, ou monter un environnement de recette, imposait de
 * modifier le code applicatif — donc de le rediffuser pour un réglage
 * qui n'est pas du code.
 *
 * Ce fichier ne contient aucun secret : l'URL d'un projet Supabase est
 * publique par nature, puisque le navigateur l'appelle. Les secrets
 * vivent dans public.config, côté base.
 */
window.CONFIG_ALERTE = {
  base: 'https://xpcsnxyhjrpvcvsqmaxd.supabase.co/functions/v1',
};
