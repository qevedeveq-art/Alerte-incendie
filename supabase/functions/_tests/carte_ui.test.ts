import { assert, assertEquals } from "./assert.ts";

const pwa = await Deno.readTextFile("../../web/index.html");
const moderation = await Deno.readTextFile("../../web/moderation.html");
const serviceWorker = await Deno.readTextFile("../../web/sw.js");
const api = await Deno.readTextFile("api/index.ts");
const dispatch = await Deno.readTextFile("dispatch/index.ts");
const signalement = await Deno.readTextFile("signalement/index.ts");
const migrationNotifications = await Deno.readTextFile(
  "../migrations/20260726213000_35_notifications_appareil_uniquement.sql",
);

Deno.test("la carte utilise la vue satellite IGN par défaut et sait basculer", () => {
  assert(pwa.includes("ORTHOIMAGERY.ORTHOPHOTOS"));
  // Satellite et noms de localités par défaut ; plan sombre seulement quand
  // le navigateur demande d'économiser les données.
  assert(pwa.includes("if (donneesReduites) {"));
  assert(pwa.includes("planSombre.addTo(carte);"));
  assert(pwa.includes("satellite.addTo(carte);"));
  assert(pwa.includes("nomsFrancaisIGN.addTo(carte);"));
  assert(pwa.includes("erreursSatellite >= 4"));
  assert(pwa.includes("'Vue satellite + Noms français (IGN)'"));
  assert(pwa.includes("'Plan sombre': planSombre"));
});

Deno.test("la légende française distingue les statuts de preuve", () => {
  for (
    const libelle of [
      "Feux corroborés (≥2 sources)",
      "Signal fort / répété",
      "Indice automatique isolé",
      "Témoins vérifiés par quorum",
      "Témoignage non vérifié",
    ]
  ) {
    assert(pwa.includes(libelle), `Libellé absent : ${libelle}`);
  }
  // Chaque ligne de légende filtre la carte et porte son décompte.
  for (const cle of ["corrobore", "probable", "indice", "citoyen", "signalement"]) {
    assert(
      pwa.includes(`data-filtre-legende="${cle}"`),
      `Filtre de légende absent : ${cle}`,
    );
  }
});

Deno.test("les feux fiables sont des flammes et seul le non vérifié reste gris", () => {
  assert(pwa.includes("function svgFlamme("));
  assert(pwa.includes("function creerMarqueurFeu("));
  assert(pwa.includes("familles >= 2 ? 'corrobore'"));
  assert(pwa.includes("score >= 60 || puissance >= 50 || observations >= 3"));
  // Le témoignage non vérifié garde la teinte grise de la charte.
  assert(pwa.includes("const c = COULEUR_NIVEAU.signalement;"));
  assert(pwa.includes("signalement: '#7c8a94'"));
  // Un signalement confirmé ne doit jamais emprunter la couleur d'un feu.
  assertEquals(pwa.includes("s.confirme ? '#e9873a'"), false);
});

Deno.test("une seule table de couleurs de sévérité, conforme à la charte", () => {
  // La légende et les marqueurs portaient des hex différents pour la même
  // information : deux vocabulaires visuels pour un seul sens.
  assert(pwa.includes("const COULEUR_NIVEAU = {"));
  for (
    const [niveau, hex] of [
      ["corrobore", "#ff3b30"],
      ["probable", "#ff9500"],
      ["indice", "#ffd60a"],
      ["citoyen", "#af52de"],
    ]
  ) {
    assert(pwa.includes(`${niveau}: '${hex}'`), `Couleur de charte absente : ${niveau} ${hex}`);
  }
  for (const orphelin of ["#ef3829", "#ff8c32", "#ffd43b", "#a78bfa", "#8a8a8a"]) {
    assertEquals(pwa.includes(orphelin), false, `Couleur hors charte : ${orphelin}`);
  }
  // Un seul jeu de variables, et aucune trace de l'ancienne palette chaude.
  assertEquals((pwa.match(/:root\{/g) || []).length, 1);
  for (const chaud of ["#2e2a27", "#252220", "rgba(18,16,14", "#4b4541", "rgba(240,68,56"]) {
    assertEquals(pwa.includes(chaud), false, `Reste de l'ancienne palette : ${chaud}`);
  }
});

Deno.test("la légende masque réellement le niveau qu'elle annonce", () => {
  // Cliquer « indices isolés » remettait le filtre à « tous » en annonçant
  // l'inverse : seuls corroboré et probable agissaient.
  assert(pwa.includes("const niveauxMasques = new Set()"));
  assert(pwa.includes("!masques.has(aspect.niveau)"));
  assert(pwa.includes("niveauxMasques.has('signalement')"));
  assert(pwa.includes("function majEtatLegende("));
  assertEquals(pwa.includes("Filtre réactif de légende activé"), false);
  // Le repli de la légende est effectif, et ouvert par défaut.
  assert(pwa.includes(".legende-carte.ouverte .contenu-legende{display:block"));
  assert(pwa.includes("'legende-carte ouverte'"));
});

Deno.test("la carte explique les preuves et sépare les sources contextuelles", () => {
  assert(pwa.includes("Preuves disponibles"));
  assert(pwa.includes("chronologie"));
  assert(pwa.includes("Contexte EFFIS"));
  assert(pwa.includes("Météo des forêts officielle"));
  assert(pwa.includes("Il ne décrit ni le périmètre, ni la direction du feu"));
});

Deno.test("le signalement utilise un formulaire structuré", () => {
  for (
    const identifiant of [
      "sigNature",
      "sigIntensite",
      "sigVegetation",
      "sigCertitude",
      "sigObserveAt",
      "sigHabitations",
    ]
  ) {
    assert(pwa.includes(`id="${identifiant}"`), `Champ absent : ${identifiant}`);
  }
  assertEquals(pwa.includes("const nature = prompt("), false);
});

Deno.test("l’interface est carte-first, responsive et navigable sur mobile", () => {
  assert(pwa.includes('id="sectionCarte"'));
  assert(pwa.includes('class="navigation-mobile"'));
  assert(pwa.includes(".anonyme #vueApp{order:1}"));
  assert(pwa.includes('id="btnVoirCarte"'));
  // La carte est l'élément principal : elle occupe la colonne large et une
  // hauteur généreuse, et reprend toute la largeur sous 900 px.
  assert(pwa.includes("grid-template-columns:minmax(0,2.3fr) minmax(320px,.6fr)"));
  assert(pwa.includes("#map{height:clamp(560px,72vh,760px)}"));
  assert(pwa.includes("@media(max-width:900px)"));
  assert(pwa.includes("#map{height:clamp(400px,56vh,560px)}"));
  // Cadre et fraîcheur sont lisibles au-dessus de la carte.
  assert(pwa.includes('class="bandeau-carte"'));
  assert(pwa.includes('id="fraicheurCarte"'));
  assert(pwa.includes("function majFraicheurCarte("));
});

Deno.test("les surcouches se positionnent sur la carte, pas sur toute la fiche", () => {
  // .carte-carte contient la recherche, la carte, les commandes, les filtres
  // et la liste. Ancrer les surcouches dessus plaçait le cadre au-dessus de la
  // barre de recherche, centrait le viseur sur la fiche entière et faisait
  // masquer les commandes par le voile de chargement.
  const zone = pwa.slice(pwa.indexOf('<div class="zone-carte">'));
  const fin = zone.indexOf('</div>\n        <div class="resume-carte"');
  const bloc = zone.slice(0, fin > 0 ? fin : 2000);
  for (
    const enfant of [
      'id="map"',
      'class="bandeau-carte"',
      'id="viseurSignalement"',
      'id="chargementCarte"',
    ]
  ) {
    assert(bloc.includes(enfant), `Surcouche hors de la zone carte : ${enfant}`);
  }
  assert(pwa.includes(".zone-carte{position:relative"));
  assert(pwa.includes(".zone-carte:after{"), "le dégradé bas doit suivre la carte");
  assertEquals(pwa.includes(".carte-carte:after{"), false);
});

Deno.test("les commandes de la carte ne se recouvrent pas", () => {
  // Zoom et sélecteur de fond étaient en haut à gauche, sous le libellé de
  // cadre ; la légende occupait le coin bas droit, sur l'attribution.
  assert(pwa.includes("zoomControl: false"));
  assert(pwa.includes("L.control.zoom({ position: 'topright'"));
  assert(pwa.includes("}, { position: 'topright', collapsed: true })"));
  assert(pwa.includes("L.control({ position: 'bottomleft' })"));
  assert(pwa.includes(".zone-carte .leaflet-top{top:40px}"));
  // Le voile de chargement doit passer au-dessus des contrôles Leaflet (800).
  const m = /\.chargement-carte\{[^}]*z-index:(\d+)/.exec(pwa);
  assert(m && Number(m[1]) > 800, "le voile de chargement doit couvrir les contrôles");
  // Les surcouches décoratives ne doivent pas intercepter les clics.
  for (const sel of [".bandeau-carte", ".zone-carte:after", ".viseur-tactique"]) {
    const r = new RegExp(`\\${sel}\\{[^}]*\\}`).exec(pwa.replace(/\s+/g, " "));
    assert(r && r[0].includes("pointer-events:none"), `${sel} doit laisser passer les clics`);
  }
});

Deno.test("les compteurs de légende sont alimentés dès le premier rendu", () => {
  // Les compteurs vivent dans un contrôle Leaflet créé par initCarte : sans
  // rappel explicite après l'initialisation, ils restaient à zéro jusqu'à la
  // première interaction avec la carte.
  const anonyme = pwa.slice(pwa.indexOf("document.body.classList.add('anonyme')"));
  const blocAnonyme = anonyme.slice(0, anonyme.indexOf("} else {"));
  assert(blocAnonyme.includes("initCarte();"));
  assert(blocAnonyme.includes("rendreResumeCarte();"), "rendu initial des compteurs manquant");
  const dessine = pwa.slice(pwa.indexOf("function dessinerCarte()"));
  const blocDessine = dessine.slice(0, dessine.indexOf("\n}"));
  assert(blocDessine.includes("rendreResumeCarte();"));
});

Deno.test("l’espace autour de la carte n’est pas gaspillé", () => {
  // La légende existait deux fois : flottante sur la carte, et répétée à
  // l'identique dans une bande en dessous, compteurs compris.
  assertEquals(pwa.includes("legende-interactive-barre"), false);
  assertEquals(pwa.includes("cntCorroboreB"), false);
  // Commandes, période et frise temporelle tiennent dans une seule barre.
  assert(pwa.includes('class="barre-carte-fin"'));
  assert(pwa.includes('<div class="barre-temporelle" id="barreTemporelle"'));
  const debut = pwa.indexOf('class="carte carte-carte"');
  const bloc = pwa.slice(debut, pwa.indexOf("</section>", debut));
  const bandes = ["recherche-carte", "barre-carte", "filtres-sources", "resume-carte"];
  for (const b of bandes) assert(bloc.includes(b), `Bande absente : ${b}`);
  // Une seule barre de commandes, pas trois empilées.
  assertEquals((bloc.match(/class="barre-carte"/g) || []).length, 1);
});

Deno.test("l’espacement suit une échelle, et le markup ne la contourne pas", () => {
  assert(pwa.includes("--e1:4px; --e2:8px; --e3:12px; --e4:16px"));
  const style = pwa.slice(pwa.indexOf("<style>"), pwa.indexOf("</style>"));
  // Aucune valeur d'espacement hors échelle de 4 px (1px et 2px restent
  // admis pour les filets et les micro-décalages).
  const horsEchelle = new Set<string>();
  for (const m of style.matchAll(/(?:padding|margin|gap)[a-z-]*:\s*([^;}]+)/g)) {
    for (const t of m[1].split(/\s+/)) {
      const px = /^(\d+)px$/.exec(t);
      if (px && Number(px[1]) % 4 !== 0 && Number(px[1]) > 2) horsEchelle.add(t);
    }
  }
  assertEquals([...horsEchelle].sort(), [], "valeurs d'espacement hors échelle");
  // Le markup ne doit plus poser de marges à la main : seuls les styles
  // réellement dynamiques subsistent.
  const markup = pwa.slice(pwa.indexOf("</style>"));
  const enLigne = markup.match(/style="[^"]*"/g) || [];
  const statiques = enLigne.filter((s) => !s.includes("${"));
  assertEquals(statiques, [], `styles en ligne statiques restants : ${statiques.join(" | ")}`);
});

Deno.test("la charte 1A est appliquée : typographies, fonds et formes", () => {
  // Les deux familles sont servies par le dépôt, plus par Google Fonts.
  assert(pwa.includes('href="./vendor/polices/polices.css"'));
  assert(pwa.includes("'Inter'"));
  assert(pwa.includes("'Outfit'"));
  assert(pwa.includes("--fond:#0b0d10"));
  assert(pwa.includes("--fond2:#141820"));
  assert(pwa.includes("--fond3:#1c2024"));
  assert(pwa.includes("--bord:#2d3339"));
  assert(pwa.includes("--ombre:0 18px 50px rgba(0,0,0,.35)"));
  // Marque : flamme deux tons de la charte.
  assert(pwa.includes('fill="#ff3b30"'));
  assert(pwa.includes('fill="#ff9500"'));
  // La couleur du thème suit le fond de page, plus l'ancien rouge brique.
  assert(pwa.includes('name="theme-color" content="#0b0d10"'));
  // Respect du réglage système sur les animations.
  assert(pwa.includes("@media(prefers-reduced-motion:reduce)"));
});

Deno.test("la carte regroupe, filtre et détaille les incidents", () => {
  assert(pwa.includes('class="cluster-bulle"'));
  assert(pwa.includes("function feuxFiltres()"));
  assert(pwa.includes("function ouvrirIncident("));
  assert(pwa.includes('id="dialogIncident"'));
  assert(pwa.includes('data-heures="1"'));
  assert(pwa.includes('data-confiance="corrobore"'));
  assert(pwa.includes('id="listeFeuxVisibles"'));
});

Deno.test("le consentement précède et verrouille la création du compte", () => {
  const consentement = pwa.indexOf('id="consentement"');
  const creation = pwa.indexOf('id="btnCommencer"');
  assert(consentement >= 0);
  assert(creation > consentement);
  assert(pwa.slice(creation, creation + 160).includes("disabled"));
});

Deno.test("le mode hors ligne et l’installation PWA sont explicites", () => {
  assert(pwa.includes('id="bandeauOffline"'));
  assert(pwa.includes("alerte-incendie:feux-cache"));
  assert(pwa.includes("beforeinstallprompt"));
  assert(pwa.includes('id="btnInstaller"'));
  assert(serviceWorker.includes("basemaps.cartocdn.com"), "cache des tuiles de repli");
  // Tout ce qu'il faut pour afficher l'application est pré-caché dès
  // l'installation, puisque tout est servi par le dépôt.
  for (
    const ressource of [
      "./vendor/leaflet/leaflet.js",
      "./vendor/leaflet/leaflet.css",
      "./vendor/polices/polices.css",
    ]
  ) {
    assert(serviceWorker.includes(ressource), `ressource non pré-cachée : ${ressource}`);
  }
});

Deno.test("l’application ne dépend d’aucun CDN tiers pour s’afficher", () => {
  // Une panne d'unpkg rendait la carte inaffichable pour un visiteur qui
  // n'était jamais venu : le cache ne pouvait pas le sauver, il était vide.
  // Google Fonts envoyait en outre son adresse IP hors UE dès la première
  // visite, sans consentement.
  for (const fichier of [pwa, moderation, serviceWorker]) {
    for (const cdn of ["unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com", "cdnjs"]) {
      const lignes = fichier.split("\n").filter((l) =>
        l.includes(cdn) && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("//") &&
        !l.trimStart().startsWith("<!--") && !l.includes("Ils venaient")
      );
      assertEquals(lignes, [], `dépendance CDN restante (${cdn}) : ${lignes.join(" | ")}`);
    }
  }
  assert(pwa.includes('href="./vendor/leaflet/leaflet.css"'));
  assert(pwa.includes('src="./vendor/leaflet/leaflet.js"'));
  assert(pwa.includes('href="./vendor/polices/polices.css"'));
  assert(moderation.includes('href="./vendor/polices/polices.css"'));
});

Deno.test("un appareil vierge peut rejoindre un espace existant", () => {
  // Deux défauts se combinaient sur le cas « second téléphone » : la section
  // des notifications portait data-prive, donc invisible sans compte, et le
  // dialogue de clé était en lecture seule — on pouvait quitter un appareil,
  // jamais en rejoindre un.
  assertEquals(pwa.includes('<section id="sectionAlertes" data-prive>'), false);
  assert(pwa.includes('<section id="sectionAlertes">'));
  assert(pwa.includes('class="carte pad bloc-anonyme"'));
  assert(pwa.includes('id="btnCreerEspace"'));
  assert(pwa.includes('id="btnSaisirCle"'));
  // Le champ de saisie existe et n'est pas en lecture seule.
  assert(pwa.includes('id="champCleSaisie"'));
  assert(pwa.includes('id="btnUtiliserCle"'));
  const champ = pwa.slice(pwa.indexOf('id="champCleSaisie"'));
  assertEquals(champ.slice(0, champ.indexOf(">")).includes("readonly"), false);
  // La clé est vérifiée auprès du serveur avant d'être enregistrée : une clé
  // fausse laisserait sinon une connexion apparente sans aucune alerte.
  const bloc = pwa.slice(pwa.indexOf("$('#btnUtiliserCle').onclick"));
  const corps = bloc.slice(0, bloc.indexOf("$('#btnFermerJeton')"));
  assert(corps.includes("`${API}/etat`"), "la clé doit être validée côté serveur");
  assert(
    corps.indexOf("fetch(") < corps.indexOf("localStorage.setItem"),
    "aucune clé ne doit être enregistrée avant vérification",
  );
  // Le bouton d'activation reste, lui, réservé à un compte.
  assert(pwa.includes('<div class="carte pad" data-prive>'));
});

Deno.test("on peut quitter un appareil, et la clé est montrée à temps", () => {
  // Rattacher un appareil était sans retour : saisir sa clé sur le téléphone
  // d'un proche ne pouvait s'annuler qu'en supprimant le compte entier.
  assert(pwa.includes('id="btnDetacher"'));
  const bloc = pwa.slice(pwa.indexOf("$('#btnDetacher').onclick"));
  const corps = bloc.slice(0, bloc.indexOf("$('#btnSupprimerCompte')"));
  // L'abonnement push local est coupé avant d'oublier la clé, sinon
  // l'appareil continuerait de recevoir les alertes.
  assert(corps.includes("sub.unsubscribe()"));
  assert(
    corps.indexOf("unsubscribe") < corps.indexOf("removeItem"),
    "couper la réception avant d'oublier la clé",
  );
  assert(corps.includes("demanderAction"), "une action irréversible se confirme");

  // La clé n'existe que dans ce navigateur : elle est montrée au seul moment
  // où l'utilisateur peut encore la mettre à l'abri.
  const creation = pwa.slice(pwa.indexOf("localStorage.setItem(CLE_JETON, jeton)"));
  assert(
    creation.slice(0, creation.indexOf("$('#formSignalement')")).includes(
      "ouvrirDialogueJeton()",
    ),
    "la clé doit être présentée à la création du compte",
  );
});

Deno.test("le service ne promet pas une alerte qu’il ne peut pas délivrer", () => {
  // Sans appareil vérifié, l'abonné ne reçoit rien : e-mail et Telegram ont
  // été retirés, et sur iOS les notifications exigent l'installation.
  assert(pwa.includes('id="avertissementCouverture"'));
  assert(pwa.includes("Vous ne recevrez aucune alerte"));
  assert(pwa.includes("const estIOS ="));
  assert(pwa.includes("const estInstallee ="));
  assert(pwa.includes("aucune alerte ne vous parviendra"));
  // Le clic sur « Activer » explique la cause réelle au lieu d'accuser le
  // navigateur.
  assert(pwa.includes("installez d’abord l’application sur l’écran d’accueil"));
});

Deno.test("une page ouverte en file:// explique pourquoi rien ne marchera", () => {
  // Le navigateur rejette l'enregistrement du service worker avec
  // « Script URL's scheme is not 'http' or 'https' » — incompréhensible pour
  // qui teste le fichier local. Ni notifications, ni installation, ni cache
  // hors ligne ne sont possibles hors contexte sécurisé.
  assert(pwa.includes("function contexteSecurise("));
  assert(pwa.includes("window.isSecureContext === false"));
  assert(pwa.includes('id="noteContexte"'));
  assert(pwa.includes("ouverte depuis un fichier local"));
  // L'enregistrement au démarrage est conditionné, plus tenté à l'aveugle.
  assert(pwa.includes("if ('serviceWorker' in navigator && contexteSecurise())"));
  const activer = pwa.slice(pwa.indexOf("async function activerPush()"));
  const corps = activer.slice(0, activer.indexOf("\n}"));
  assert(
    corps.indexOf("contexteSecurise()") < corps.indexOf("serviceWorker.register"),
    "le contexte doit être vérifié avant toute tentative d'enregistrement",
  );
});

Deno.test("la configuration de déploiement sort du code applicatif", () => {
  assert(pwa.includes('<script src="./config.js"></script>'));
  assert(moderation.includes('<script src="./config.js"></script>'));
  assert(pwa.includes("window.CONFIG_ALERTE"));
  assert(serviceWorker.includes("./config.js"), "config.js doit être pré-caché");
});

Deno.test("les heures silencieuses portent un nom accessible", () => {
  assert(pwa.includes('aria-label="Début des heures silencieuses"'));
  assert(pwa.includes('aria-label="Fin des heures silencieuses"'));
  assert(pwa.includes('aria-labelledby="libelleSilence"'));
});

Deno.test("dispatch rend la main avant d’être coupé en plein envoi", () => {
  assert(dispatch.includes("const BUDGET_MS"));
  assert(dispatch.includes("Date.now() - debut > BUDGET_MS"));
  assert(dispatch.includes("reportees"));
  // Une alerte reportée ne doit pas consommer de tentative.
  const boucle = dispatch.slice(dispatch.indexOf("const debut = Date.now()"));
  const corps = boucle.slice(0, boucle.indexOf("await fermerRun"));
  assertEquals(corps.includes("tentatives"), false);
});

Deno.test("dispatch réserve atomiquement son lot et libère les lignes reportées", () => {
  assert(dispatch.includes('sb.rpc("reserver_alertes"'));
  assert(dispatch.includes('sb.rpc("liberer_alertes"'));
  assert(dispatch.includes('.eq("claim_id", lotId)'));
  assertEquals(dispatch.includes('sb.rpc("alertes_a_envoyer"'), false);
});

Deno.test("la carte est servie depuis un cache, sans mentir sur son âge", () => {
  assert(api.includes('sb.rpc("feux_carte_servie"'));
  assert(api.includes("age_secondes"));
  assert(api.includes("calcule_at"));
  // Le client affiche la date de calcul du serveur, pas celle de son fetch.
  assert(pwa.includes("derniereMajCarte = j.calcule_at"));
  assert(pwa.includes("Calculé ${relatif(derniereMajCarte)}"));
  assert(pwa.includes("origineCarte = j.origine"));
  assert(pwa.includes("Cache calculé ${ageLisible}"));
});

Deno.test("les notifications ouvrent l’incident et distinguent l’action de signalement", () => {
  assert(dispatch.includes("?evt=${encodeURIComponent"));
  assert(serviceWorker.includes("e.action === 'confirmer'"));
  assert(serviceWorker.includes("await c.navigate(cible)"));
  assert(pwa.includes("x.evenement_id === evenementDemande"));
  assert(pwa.includes("paramsNotification.get('action') === 'confirmer'"));
});

Deno.test("aucune direction de vent n’est présentée comme propagation du feu", () => {
  assert(pwa.includes("direction vers laquelle souffle le vent"));
  assertEquals(pwa.includes("<small>propagation probable</small>"), false);
});

Deno.test("l’API refuse les jetons en URL et impose les méthodes mutantes", () => {
  assertEquals(api.includes('searchParams.get("token")'), false);
  assert(api.includes('test: "POST"'));
  assert(api.includes('"compte-supprimer": "POST"'));
  assert(api.includes('return json({ erreur: "méthode non autorisée" }, 405)'));
});

Deno.test("la recherche publique localise une commune sans créer de compte", () => {
  assert(pwa.includes('id="rechLieu"'));
  assert(pwa.includes("function afficherLieu("));
  assert(pwa.includes("function rendreResumeCarte()"));
  assert(api.includes("codePostal=${encodeURIComponent(q)}"));
  assert(api.includes("population,centre"));
  assert(api.includes("lat: c.centre?.coordinates?.[1]"));
  assert(pwa.includes("fetch(`${API}/communes?q="));
});

Deno.test("les parcours sensibles utilisent des dialogues accessibles", () => {
  assert(pwa.includes('id="dialogAction"'));
  assert(pwa.includes('id="dialogJeton"'));
  assertEquals(/(^|[^\w.])(?:prompt|confirm|alert)\s*\(/m.test(pwa), false);
});

Deno.test("les notifications sont limitées aux appareils Web Push", () => {
  assert(pwa.includes("Notifications sur vos appareils"));
  assert(pwa.includes("type: 'webpush'"));
  assertEquals(pwa.includes('id="btnEmail"'), false);
  assertEquals(pwa.includes('id="btnTelegram"'), false);
  assertEquals(pwa.includes('id="dialogEmail"'), false);

  assert(api.includes('body.type !== "webpush"'));
  assert(api.includes('.eq("type", "webpush")'));
  assertEquals(dispatch.includes("SMTPClient"), false);
  assertEquals(dispatch.includes("envoyerTelegram"), false);
  assert(dispatch.includes('canal.type !== "webpush"'));
  assert(signalement.includes('.select("type, actif, verifie")'));

  assert(migrationNotifications.includes("delete from public.canaux"));
  assert(migrationNotifications.includes("type in ('email', 'telegram')"));
  assert(migrationNotifications.includes("check (type = 'webpush')"));
});

Deno.test("la carte s’actualise pour tous et respecte l’économie de données", () => {
  assert(pwa.includes("setInterval(actualiserDonnees, 120000)"));
  assert(pwa.includes("navigator.connection?.saveData === true"));
  assert(pwa.includes("actualisationEnCours"));
});

Deno.test("la console de modération ne persiste pas la clé administrateur", () => {
  assert(moderation.includes('id="cle" type="password"'));
  assert(moderation.includes("let cleAdmin=''"));
  assertEquals(moderation.includes("localStorage"), false);
  assertEquals(moderation.includes("sessionStorage"), false);
  assert(moderation.includes("'x-admin-key':cleAdmin"));
  assert(moderation.toLowerCase().includes("motif obligatoire"));
  assert(moderation.includes('id="dialogDecision"'));
  assertEquals(
    /(^|[^\w.])(?:prompt|confirm|alert)\s*\(/m.test(moderation),
    false,
  );
});
