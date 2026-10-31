// Accès au fournisseur (API "Xtream Codes") : identifiants et appels HTTP.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

// Une URL de chaîne live du M3U : http://hote/user/pass/id
const LIVE_URL = /(https?:\/\/[^/\s]+)\/([^/\s]+)\/([^/\s]+)\/\d+\s*$/m;

let config = null;

function readConfig() {
  if (!config && fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return config;
}

// Noms des playlists .m3u déposées à la racine du projet.
function m3uFiles() {
  return fs.readdirSync(ROOT).filter((f) => f.toLowerCase().endsWith('.m3u'));
}

// Extrait serveur/identifiants de la première chaîne live du M3U et les enregistre dans config.json.
// `name` : playlist choisie à l'écran d'accueil (la première trouvée par défaut).
function importConfigFromM3u(name) {
  const files = m3uFiles();
  if (!files.length) throw new Error('Aucun fichier .m3u trouvé à la racine du projet');
  if (name && !files.includes(name)) throw new Error(`Playlist introuvable : ${name}`);
  const file = path.join(ROOT, name || files[0]);
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.alloc(256 * 1024);
  const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
  fs.closeSync(fd);
  const m = buffer.toString('utf8', 0, bytes).match(LIVE_URL);
  if (!m) throw new Error(`Aucune URL de chaîne reconnue dans ${path.basename(file)}`);
  config = { server: m[1], username: m[2], password: m[3] };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`Identifiants lus depuis ${path.basename(file)} et enregistrés dans config.json`);
  return config;
}

// Déconnexion : oublie les identifiants (la playlist .m3u, elle, reste en place).
function forgetConfig() {
  config = null;
  fs.rmSync(CONFIG_FILE, { force: true });
}

function requireConfig() {
  const c = readConfig();
  if (!c) throw new Error('Pas encore configuré : lancer l\'import');
  return c;
}

function fetchUpstream(url, signal) {
  return fetch(url, { redirect: 'follow', signal, headers: { 'User-Agent': USER_AGENT } });
}

async function api(action, params = {}) {
  const { server, username, password } = requireConfig();
  const query = new URLSearchParams({ username, password, action, ...params });
  const res = await fetchUpstream(`${server}/player_api.php?${query}`);
  if (!res.ok) throw new Error(`API ${action} : HTTP ${res.status}`);
  return res.json();
}

// Guide des programmes complet au format XMLTV (environ 3 jours, toutes chaînes).
async function xmltv() {
  const { server, username, password } = requireConfig();
  const res = await fetchUpstream(`${server}/xmltv.php?${new URLSearchParams({ username, password })}`);
  if (!res.ok) throw new Error(`XMLTV : HTTP ${res.status}`);
  return res.text();
}

// URL des flux côté fournisseur (elles redirigent vers un serveur de diffusion avec jeton).
const urls = {
  live(id) {
    const { server, username, password } = requireConfig();
    return `${server}/live/${username}/${password}/${id}.m3u8`;
  },
  // start au format du fournisseur : "AAAA-MM-JJ:HH-mm" (heure du serveur)
  replay(id, start, minutes) {
    const { server, username, password } = requireConfig();
    return `${server}/timeshift/${username}/${password}/${minutes}/${start}/${id}.m3u8`;
  },
  // kind : "movie" ou "series"
  media(kind, id, ext) {
    const { server, username, password } = requireConfig();
    return `${server}/${kind}/${username}/${password}/${id}.${ext}`;
  },
};

module.exports = { USER_AGENT, readConfig, m3uFiles, importConfigFromM3u, forgetConfig, fetchUpstream, api, xmltv, urls };
