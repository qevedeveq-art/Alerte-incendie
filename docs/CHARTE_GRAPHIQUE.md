# Charte graphique — direction 1A, tactique sombre

Direction retenue le 26 juillet 2026 dans le projet de design
« Design incendie et alerte ». À appliquer à tout nouvel écran ou composant.
Ce fichier est la copie de référence dans le dépôt : le projet de design reste
la maquette vivante, mais c'est ici que le code est arbitré.

## Couleurs

| Rôle | Valeur |
|---|---|
| Fond de page | `#0b0d10` |
| Fond carte / panneau | `#141820` |
| Fond insert / bouton secondaire | `#1c2024` |
| Bordures | `#2d3339` (survol `#39414a`) |
| Texte primaire | `#ffffff` |
| Texte secondaire | `#cacad0` |
| Texte tertiaire, libellés | `#959ca4` |

### Sévérité

| Niveau | Couleur | Badge |
|---|---|---|
| Info / non vérifié | `#7c8a94` | fond `rgba(124,138,148,.16)`, texte `#9fb0bb` |
| Alerte, signal fort ou répété | `#ff9500` | fond `rgba(255,149,0,.16)`, texte `#f0a05e` |
| Critique, sources concordantes | `#ff3b30` | fond `rgba(255,59,48,.16)`, texte `#ff7b72` |
| Indice isolé | `#ffd60a` | — |
| Témoins vérifiés | `#af52de` | — |
| Positif, santé | `#3fa86b` | — |

Une seule table de couleurs de sévérité existe dans le code
(`COULEUR_NIVEAU` dans `web/index.html`). La légende et les marqueurs doivent
en dériver : deux teintes différentes pour la même information reviennent à
tenir deux discours sur la même preuve.

## Typographie

- Titres et emphase : **Outfit** (500–800)
- Corps et interface : **Inter** (400–700)
- Import : `Inter:wght@400;550;600;700` + `Outfit:wght@500;650;700;800`

## Composants

- Cartes : rayon 16–22 px, `1px solid #2d3339`, ombre `0 18px 50px rgba(0,0,0,.35)`
- Boutons primaires : fond `#ff3b30`, texte blanc. Secondaires : fond `#1c2024`, bordure `#2d3339`
- Marque : flamme deux tons `#ff3b30` + `#ff9500`, tracé SVG de l'application
- Libellés de section : capitales, `letter-spacing:.09em`, couleur tertiaire

## Ton

Sérieux, sobre, jamais alarmiste. Pas de rouge sang agressif, pas d'icône
dramatique. La hiérarchie se lit par la couleur de sévérité, pas par
l'emphase visuelle. Une seule chose respire sur la carte : la concordance de
plusieurs familles indépendantes. Si tout clignote, plus rien ne hiérarchise.

## La carte est l'élément principal

- Desktop : grille `2.3fr` pour la carte, `0.6fr` pour le panneau latéral
- Hauteur : `clamp(560px, 72vh, 760px)` ; `clamp(400px, 56vh, 560px)` en mobile
- Visuelle et réactive : marqueurs colorés par sévérité, marqueur corroboré
  qui respire, zoom fonctionnel, marqueurs cliquables ouvrant une fiche
- Cadre et fraîcheur en surimpression haute, scrim bas pour la profondeur
- Légende flottante en bas à gauche, repliable et **ouverte par défaut** :
  la clé de lecture d'une carte d'alerte ne se mérite pas par un clic
- Chaque ligne de légende masque réellement son niveau, avec un état visible

## Responsive

- Bascule à 900 px : la carte reprend toute la largeur, le panneau passe dessous
- Sous 560 px : navigation basse fixe (Carte / Alertes / Signaler / Compte),
  légende compacte toujours dépliée, barre de commandes défilante
- `prefers-reduced-motion` coupe toutes les animations décoratives

## Règle qui prime sur l'esthétique

Aucune couleur, aucune animation et aucun libellé ne doit suggérer une
information que les sources ne mesurent pas. Un état daté ne se présente
jamais comme un état à jour : le voyant de fraîcheur passe en teinte
d'avertissement dès que la carte affiche un cache.
