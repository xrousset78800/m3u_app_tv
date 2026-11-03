# m3u_app_tv

Lecteur IPTV local pour un abonnement **Xtream Codes** : chaînes en direct, films, séries,
guide des programmes et replay, dans le navigateur.

## Fonctionnalités

- **Programme** : ce qui passe en ce moment, ce soir ou demain soir, chaîne par chaîne.
  Un clic lance le direct, ou le replay d'un programme déjà diffusé.
- **TV** : chaînes en direct (HLS), guide des programmes par jour et replay quand la chaîne le permet.
- **Films / Séries** : fiches détaillées, lecture avec reprise là où on s'était arrêté,
  choix de la piste audio (VF par défaut), enchaînement des épisodes, playlist.
- Vrai plein écran (bouton ou touche `F`, double-clic sur la vidéo) : les onglets et la liste
  restent accessibles en approchant la souris du bord haut ou gauche.
- La fiche (programme, film, épisodes) est dans une colonne repliée, qui se déplie au bord droit de l'écran.
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

Pour une version plus importante : `npm version minor` (1.1.0) ou `npm version major` (2.0.0),
puis `git push --follow-tags`.

## Connexion

Au premier lancement, l'appli demande les accès **Xtream Codes** de l'abonnement :
adresse du serveur, utilisateur et mot de passe. Pour les remplir automatiquement :

- **Choisir un fichier .m3u** : seul le début du fichier est lu, dans le navigateur, rien n'est envoyé ;
- ou **coller le lien de la playlist** (`http://serveur/get.php?username=…&password=…`).

Les accès sont vérifiés auprès du fournisseur puis enregistrés dans `config.json`.
L'appli importe alors chaînes, films, séries et guide des programmes dans `tv.db`,
et tout est ensuite servi depuis la base. Le bouton **Mettre à jour le catalogue** relance l'import,
et le guide se rafraîchit seul toutes les 6 heures.

**Se déconnecter** vide la base et oublie les accès : on revient à l'écran de connexion,
par exemple pour changer d'abonnement.

> `config.json`, `tv.db` et les playlists contiennent ou dérivent des accès
> de l'abonnement : ils sont exclus du dépôt par le `.gitignore`.

## Fonctionnement

| Contenu | Ce que fait le serveur |
| --- | --- |
| Direct et replay | Résout les redirections authentifiées du fournisseur et réécrit la playlist HLS pour que les segments passent par `/proxy`. Lu dans le navigateur avec hls.js. |
| Films et épisodes | Convertit à la volée avec ffmpeg en MP4 fragmenté : vidéo copiée si le navigateur la lit (H.264, HEVC si supporté), sinon réencodée en H.264 ; audio converti en AAC. |

L'abonnement n'autorise qu'**une connexion à la fois** : lancer une lecture arrête la précédente.

## Structure

```
electron/main.js appli de bureau : démarre le serveur et ouvre la fenêtre
server.js        serveur HTTP : API, proxy HLS, flux convertis, fichiers statiques
lib/xtream.js    accès au fournisseur (configuration, API, URL de lecture)
lib/db.js        base SQLite : import du catalogue et du guide, requêtes
lib/hls.js       résolution des redirections et réécriture des playlists HLS
lib/media.js     analyse et conversion ffmpeg des films et épisodes
public/          interface (HTML, CSS, JS sans framework)
```
