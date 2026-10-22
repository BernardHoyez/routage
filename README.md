# routage

PWA pour animateurs de randonnée : à partir d'un point de départ (pointé sur la carte ou saisi en lat/lon) et d'une distance choisie au curseur, propose des boucles par routage piéton et exporte la boucle choisie en GPX et KML.

- Fonds : OpenStreetMap, IGN Plan V2, IGN BD Ortho (Leaflet 1.9.4 embarqué dans `lib/`)
- Routage (sans clé) : IGN Géoplateforme (BDTOPO piéton), Valhalla, BRouter (randonnée), OSRM piéton — repli automatique possible
- Principe : points de passage répartis sur un cercle passant par le départ, diamètre ajusté en 2 à 4 itérations jusqu'à la distance voulue ; boucles classées par écart de distance et par part d'aller-retour
- Déploiement : GitHub Pages, `https://bernardhoyez.github.io/routage/`
- Service worker « brise-cache » : incrémenter `CACHE_NAME` dans `sw.js` à chaque livraison
