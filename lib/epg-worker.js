// Import du guide (XMLTV) dans un fil à part : le serveur tourne dans le processus de l'appli,
// et ce travail la figerait. L'ancien guide reste consultable jusqu'au remplacement final.

const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text) {
  return text.replace(/&(#x?[0-9a-f]+|\w+);/gi, (match, entity) => {
    if (entity[0] !== '#') return XML_ENTITIES[entity] ?? match;
    return String.fromCodePoint(entity[1] === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1)));
  });
}

// "20261030173000 +0100" -> timestamp Unix
function parseXmltvDate(text) {
  const m = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, sign, oh, om] = m;
  const offset = (sign === '-' ? -1 : 1) * (Number(oh) * 60 + Number(om)) * 60;
  return Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - offset;
}

const { file, xml } = workerData;
const db = new DatabaseSync(file);
db.exec('PRAGMA busy_timeout = 10000');

const attr = (attrs, name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';
const tag = (body, name) => (body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '';
let count = 0;

db.exec('BEGIN IMMEDIATE');
try {
  db.exec(`DROP TABLE IF EXISTS programmes_new;
           CREATE TABLE programmes_new (channel TEXT NOT NULL, start INTEGER NOT NULL, stop INTEGER NOT NULL, title TEXT NOT NULL, description TEXT);`);
  const insert = db.prepare('INSERT INTO programmes_new VALUES (?, ?, ?, ?, ?)');
  for (const [, attrs, body] of xml.matchAll(/<programme\s([^>]*)>([\s\S]*?)<\/programme>/g)) {
    const start = parseXmltvDate(attr(attrs, 'start'));
    const stop = parseXmltvDate(attr(attrs, 'stop'));
    const channel = attr(attrs, 'channel').toLowerCase();
    if (!start || !stop || !channel) continue;
    insert.run(channel, start, stop, decodeXml(tag(body, 'title')).trim(), decodeXml(tag(body, 'desc')).trim() || null);
    count++;
  }
  db.exec(`DROP TABLE programmes;
           ALTER TABLE programmes_new RENAME TO programmes;
           CREATE INDEX programmes_channel ON programmes (channel, start);`);
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run('epg_synced_at', new Date().toISOString());
  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
parentPort.postMessage(count);
