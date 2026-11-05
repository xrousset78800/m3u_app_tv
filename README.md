# m3u_app_tv

Lecteur IPTV local pour un abonnement **Xtream Codes** : chaînes en direct, films, séries,
guide des programmes et replay, dans le navigateur.

## Fonctionnalités

- **TV** : chaînes en direct (HLS) avec ce qui passe en ce moment, chaîne par chaîne.
  Recherche, catégories et sélection personnelle de favoris (étoile, à réordonner en les faisant glisser).
  Un clic sur une chaîne ouvre sa fiche, avec le guide complet par jour et le replay des programmes déjà diffusés ;
  le bouton ▶ de la ligne lance le direct.
- **Films / Séries** : favoris comme pour la TV (étoile sur la ligne ou dans la fiche ; pour une série,
  c'est la série entière), fiches détaillées, lecture avec reprise là où on s'était arrêté,
  choix de la piste audio (VF par défaut), enchaînement des épisodes, playlist.
  Titres et résumés traduits avec [TMDB](https://www.themoviedb.org) dans la langue de l'appli :
  les textes des fournisseurs mélangent souvent les langues d'une saison à l'autre.
  Une série n'est retenue que si ses épisodes portent les identifiants TMDB donnés par le fournisseur ;
  sans identifiant ni traduction, les textes du fournisseur restent affichés.
- **Réglages** (⚙) : compte, mise à jour du catalogue, et chaînes, films, séries ou groupes entiers
  à retirer (Maj + clic pour toute une plage). Ces choix sont réversibles et conservés quand le catalogue est mis à jour.
- Tout est à gauche du lecteur, sur deux colonnes : d'abord le menu, les chaînes ou la liste, le statut et la playlist ;
  puis la fiche (programme de la chaîne, film, épisodes), qui n'apparaît que lorsqu'il y a quelque chose à y montrer
  et se referme quand la souris rejoint la vidéo. Les longs résumés sont coupés, avec un lien « voir plus ».
- **Langue** : le drapeau à côté de ☰ change la langue de toute l'appli (français, anglais, allemand,
  espagnol, italien, portugais) et des fiches traduites. Au premier lancement, c'est celle du système, sinon le français.
- Les colonnes ne s'ouvrent et ne se ferment qu'avec le bouton ☰ ou la touche `L`.
- Vrai plein écran (bouton du lecteur, touche `F` ou double-clic sur la vidéo, `Échap` pour en sortir) : les colonnes restent comme elles étaient,
  et ☰ ou `L` les ferment pour laisser tout l'écran à la vidéo.
- Si le fournisseur refuse un flux en direct, trois nouvelles tentatives automatiques, puis un message
  qui donne la cause (code HTTP du refus, ou fournisseur injoignable).
- Catalogue et guide stockés dans une base SQLite locale : l'interface reste rapide,
  même avec des dizaines de milliers d'entrées.

## Installer l'appli (Windows)

**[Télécharger TV pour Windows](https://github.com/xrousset78800/m3u_app_tv/releases/latest/download/TV-Setup.exe)**
(toujours la dernière version) et lancer le fichier :
l'appli s'installe sans droits administrateur et crée un raccourci **TV** sur le bureau
et dans le menu Démarrer. Elle se met ensuite à jour toute seule.

L'installateur n'est pas signé : au premier lancement, Windows affiche
« Windows a protégé votre ordinateur ». Cliquer sur **Informations complémentaires**
puis **Exécuter quand même**.

Les données (accès, base) sont dans `%APPDATA%\TV`.

## Développement

### Prérequis

- [Node.js](https://nodejs.org) **22.5 ou plus récent** (utilise le module intégré `node:sqlite`).
- Un abonnement Xtream Codes (ses accès, ou sa playlist `.m3u`).

ffmpeg est fourni par la dépendance `ffmpeg-static`, rien d'autre à installer.

### Lancement

```bash
npm install
npm start       # dans le navigateur : http://localhost:8080 (port modifiable avec PORT)
npm run app     # dans la fenêtre de l'appli (Electron)
npm run dist    # fabrique l'installateur dans dist/
```

En développement, les données sont à la racine du projet avec `npm start`,
et dans `%APPDATA%\TV` (comme l'appli installée) avec `npm run app`.

### Publier une version

```bash
npm run release
```

Augmente la version (1.0.0 → 1.0.1), crée le commit et le tag `v1.0.1`, et pousse le tout.
GitHub Actions fabrique alors l'installateur et le publie dans une Release (quelques minutes,
suivi dans l'onglet *Actions*). Les applis installées détectent la nouvelle version au lancement,
la téléchargent en arrière-plan et proposent de redémarrer pour l'installer.

La clé TMDB n'est pas dans le dépôt : en local, la mettre dans un fichier `tmdb.key` à la racine
(ignoré par git) ; pour les installateurs, dans le secret `TMDB_KEY` du dépôt GitHub
(*Settings → Secrets and variables → Actions*). Sans clé, l'appli marche avec les textes du fournisseur.

Pour une version plus importante : `npm version minor` (1.1.0) ou `npm version major` (2.0.0),
puis `git push --follow-tags`.

## Connexion

Au premier lancement, l'appli demande les accès **Xtream Codes** de l'abonnement :
adresse du serveur, utilisateur et mot de passe. Pour les remplir automatiquement :

- **Choisir un fichier .m3u** : seul le début du fichier est lu, dans le navigateur, rien n'est envoyé ;
- ou **coller le lien de la playlist** (`http://serveur/get.php?username=…&password=…`).

Les accès sont vérifiés auprès du fournisseur puis enregistrés dans `config.json`.
L'appli importe alors chaînes, films, séries et guide des programmes dans `tv.db`,
et tout est ensuite servi depuis la base. Le bouton **Mettre à jour le catalogue** (⚙) relance l'import,
et le guide se rafraîchit seul toutes les 12 heures, en arrière-plan.

**Se déconnecter** (⚙) vide la base et oublie les accès : on revient à l'écran de connexion,
par exemple pour changer d'abonnement.

> `config.json`, `tv.db` et les playlists contiennent ou dérivent des accès
> de l'abonnement : ils sont exclus du dépôt par le `.gitignore`.

## Fonctionnement

| Contenu | Ce que fait le serveur |
| --- | --- |
| Direct et replay | Résout les redirections authentifiées du fournisseur et réécrit la playlist HLS pour que les segments passent par `/proxy`. Lu dans le navigateur avec hls.js. |
| Films et épisodes | Convertit à la volée avec ffmpeg en MP4 fragmenté : vidéo copiée si le lecteur la décode (H.264, HEVC, VP9, AV1), sinon réencodée en H.264 (carte NVIDIA si disponible, HDR ramené en SDR) ; audio converti en AAC stéréo, calé sur l'image. Un déplacement repart de l'image clé précédente, parfois quelques secondes avant le point demandé : la dernière image reste affichée en attendant, et une ouverture restée sans réponse est relancée toute seule. Au survol de la barre, l'heure visée et l'image du passage s'il a déjà été vu pendant cette lecture : une seule connexion est permise au fournisseur, on ne peut pas chercher d'images ailleurs dans le film. |

L'abonnement n'autorise qu'**une connexion à la fois** : lancer une lecture arrête la précédente.

## Structure

```
electron/main.js appli de bureau : démarre le serveur et ouvre la fenêtre
electron/preload.js pont entre la page et la fenêtre (plein écran)
server.js        serveur HTTP : API, proxy HLS, flux convertis, fichiers statiques
lib/xtream.js    accès au fournisseur (configuration, API, URL de lecture)
lib/db.js        base SQLite : import du catalogue et du guide, requêtes
lib/epg-worker.js import du guide dans un thread à part, pour ne pas figer l'appli
lib/hls.js       résolution des redirections et réécriture des playlists HLS
lib/media.js     analyse et conversion ffmpeg des films et épisodes
lib/tmdb.js      traduction des fiches avec TMDB, mise en cache dans la base
public/          interface (HTML, CSS, JS sans framework)
public/i18n/     traductions de l'interface (un JSON par langue, le français sert de référence) et drapeaux
```

Pour ajouter une langue : copier `public/i18n/fr-FR.json` sous le code TMDB de la langue (`nl-NL.json` …),
traduire les valeurs, ajouter son drapeau dans `public/i18n/flags/`, puis le code dans `LANGUAGES`
(avec le nom de la langue dans `public/app.js`, le code seul dans `electron/main.js`).
