// Journal de l'appli : ce que le serveur écrit en console va aussi, horodaté, dans tv.log
// (dossier des données, %APPDATA%\TV pour l'appli installée). Utile pour comprendre une coupure après coup :
// ouvertures des flux, reconnexions de ffmpeg, refus du fournisseur, attentes du lecteur.
// Rien qui permette de joindre l'abonnement : adresses, hôtes, identifiants et mot de passe sont masqués.
// Gardé petit : au-delà de 2 Mo, il devient tv.old.log et un nouveau commence.

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const xtream = require('./xtream');

const FILE = path.join(xtream.DATA_DIR, 'tv.log');
const OLD_FILE = path.join(xtream.DATA_DIR, 'tv.old.log');
const MAX_SIZE = 2 * 1024 * 1024;

// Hôtes de diffusion découverts en cours de route (redirections du fournisseur).
const hosts = new Set();
const secret = (host) => host && hosts.add(host);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function redact(text) {
  let out = text
    .replace(/\b(?:https?|rtmp|rtsp):\/\/[^\s"'<>]+/gi, (url) => (/^https?:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url) ? url : '<url>'))
    .replace(/\b(?!127\.0\.0\.1\b)\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>');
  let config = null;
  try {
    config = xtream.readConfig();
  } catch {}
  let server = '';
  try {
    server = config?.server && new URL(config.server).hostname;
  } catch {}
  for (const value of [server, config?.username, config?.password, ...hosts]) {
    if (value && String(value).length >= 3) out = out.replace(new RegExp(escape(String(value)), 'gi'), '<…>');
  }
  return out;
}

const stamp = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

let size = 0;
try {
  size = fs.statSync(FILE).size;
} catch {}

function write(level, line) {
  try {
    if (size > MAX_SIZE) {
      fs.renameSync(FILE, OLD_FILE);
      size = 0;
    }
    const text = `${stamp()} ${level === 'log' ? '' : `${level.toUpperCase()} `}${line}\n`;
    fs.appendFileSync(FILE, text);
    size += Buffer.byteLength(text);
  } catch {}
}

// Une seule fois, au démarrage du serveur.
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      const line = redact(util.format(...args));
      original(line);
      if (line.includes('ExperimentalWarning')) return; // avertissement de Node sur SQLite, à chaque démarrage
      write(level === 'info' ? 'log' : level, line);
    };
  }
  write('log', '--- démarrage ---');
}

module.exports = { install, secret, redact };
