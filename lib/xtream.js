// Accès au fournisseur (API "Xtream Codes") : identifiants et appels HTTP.

const fs = require('node:fs');
const path = require('node:path');

// Dossier des données (accès, base) : le projet en développement, %APPDATA%\TV dans l'appli installée.
const DATA_DIR = process.env.TV_DATA_DIR || path.join(__dirname, '..');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const USER_AGENT = 'VLC/3.0.20 LibVLC/3.0.20';

let config = null;

function readConfig() {
  if (!config && fs.existsSync(CONFIG_FILE)) config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return config;
}

// `key` et `vars` : le message traduit par l'interface (public/i18n, clés « error.* »).
const httpError = (status, message, key, vars) => Object.assign(new Error(message), { status, key, vars });

// "exemple.com", "http://exemple.com:8080/" … -> "http://exemple.com:8080"
function normalizeServer(text) {
  try {
    return new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`).origin;
  } catch {
    throw httpError(400, `Adresse de serveur invalide : ${text}`, 'invalidServer', { server: text });
  }
}

// Vérifie les accès auprès du fournisseur puis les enregistre dans config.json.
async function login({ server, username, password } = {}) {
  [server, username, password] = [server, username, password].map((v) => String(v ?? '').trim());
  if (!server || !username || !password) throw httpError(400, 'Serveur, utilisateur et mot de passe sont requis', 'missingFields');
  const candidate = { server: normalizeServer(server), username, password };

  let info;
  try {
    const res = await fetchUpstream(
      `${candidate.server}/player_api.php?${new URLSearchParams({ username, password })}`,
      AbortSignal.timeout(15000),
    );
    info = [401, 403].includes(res.status) ? {} : await res.json();
  } catch {
    throw httpError(502, `Pas de réponse Xtream Codes de ${candidate.server} : vérifie l'adresse du serveur`, 'noResponse', { server: candidate.server });
  }
  const user = info.user_info || {};
  if (Number(user.auth) !== 1) throw httpError(401, 'Identifiants refusés par le serveur', 'badCredentials');
  if (user.status && user.status !== 'Active') throw httpError(403, `Abonnement non actif (${user.status})`, 'inactive', { status: user.status });

  config = candidate;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`Connecté : ${username} sur ${candidate.server}`);
}

// Déconnexion : oublie les identifiants.
function forgetConfig() {
  config = null;
  fs.rmSync(CONFIG_FILE, { force: true });
}

function requireConfig() {
  const c = readConfig();
  if (!c) throw Object.assign(new Error('Pas encore configuré : lancer l\'import'), { key: 'notConfigured' });
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

module.exports = { DATA_DIR, USER_AGENT, readConfig, login, forgetConfig, fetchUpstream, api, xmltv, urls };
