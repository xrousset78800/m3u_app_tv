// Base SQLite locale : catalogue (chaînes, films, séries) et guide des programmes,
// importés depuis l'API du fournisseur.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const xtream = require('./xtream');

const db = new DatabaseSync(path.join(xtream.DATA_DIR, 'tv.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    type TEXT NOT NULL,          -- live | vod | series
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (type, id)
  );
  CREATE TABLE IF NOT EXISTS items (
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    search TEXT NOT NULL,        -- nom sans accents, en minuscules
    logo TEXT,
    category_id TEXT,
    ext TEXT,                    -- conteneur des films (mkv, mp4…)
    archive_days INTEGER NOT NULL DEFAULT 0,
    rating REAL,
    added INTEGER,
    position INTEGER NOT NULL,
    epg_id TEXT,                 -- identifiant XMLTV de la chaîne, en minuscules
    PRIMARY KEY (type, id)
  );
  CREATE INDEX IF NOT EXISTS items_category ON items (type, category_id, position);
  CREATE TABLE IF NOT EXISTS programmes (
    channel TEXT NOT NULL,       -- identifiant XMLTV, en minuscules
    start INTEGER NOT NULL,      -- timestamps Unix (secondes)
    stop INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT
  );
  CREATE INDEX IF NOT EXISTS programmes_channel ON programmes (channel, start);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`);

// Bases créées avant l'ajout du guide : il manque epg_id, un nouvel import est nécessaire.
const needsResync = !db.prepare('PRAGMA table_info(items)').all().some((c) => c.name === 'epg_id');
if (needsResync) db.exec('ALTER TABLE items ADD COLUMN epg_id TEXT');

function normalize(text) {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value || null;
}

function setMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, value);
}

function transaction(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// --- Catalogue ---------------------------------------------------------------------

const SOURCES = {
  live: {
    categories: 'get_live_categories',
    items: 'get_live_streams',
    map: (x) => ({
      id: x.stream_id,
      logo: x.stream_icon,
      archive_days: Number(x.tv_archive) ? Number(x.tv_archive_duration) || 0 : 0,
      epg_id: (x.epg_channel_id || '').toLowerCase(),
    }),
  },
  vod: {
    categories: 'get_vod_categories',
    items: 'get_vod_streams',
    map: (x) => ({ id: x.stream_id, logo: x.stream_icon, ext: x.container_extension }),
  },
  series: {
    categories: 'get_series_categories',
    items: 'get_series',
    map: (x) => ({ id: x.series_id, logo: x.cover }),
  },
};

async function syncCatalog() {
  const account = await xtream.api('');
  const data = {};
  for (const [type, source] of Object.entries(SOURCES)) {
    console.log(`Import : ${type}…`);
    data[type] = {
      categories: await xtream.api(source.categories),
      items: await xtream.api(source.items),
    };
  }

  const insertCategory = db.prepare('INSERT OR REPLACE INTO categories VALUES (?, ?, ?, ?)');
  const insertItem = db.prepare(`
    INSERT OR REPLACE INTO items (type, id, name, search, logo, category_id, ext, archive_days, rating, added, position, epg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  transaction(() => {
    db.exec('DELETE FROM categories; DELETE FROM items;');
    for (const [type, { categories, items }] of Object.entries(data)) {
      categories.forEach((c, i) => insertCategory.run(type, String(c.category_id), c.category_name, i));
      items.forEach((x, i) => {
        const m = SOURCES[type].map(x);
        const name = String(x.name ?? '').trim();
        insertItem.run(type, String(m.id), name, normalize(name), m.logo || null, String(x.category_id ?? ''),
          m.ext || null, m.archive_days || 0, Number(x.rating) || null, Number(x.added || x.last_modified) || null, i,
          m.epg_id || null);
      });
    }
    // Fuseau du fournisseur : les URL de replay s'expriment dans son heure locale.
    setMeta('timezone', account.server_info?.timezone || 'Europe/Paris');
    setMeta('synced_at', new Date().toISOString());
  });
}

// --- Guide des programmes (XMLTV) --------------------------------------------------

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

async function syncEpg() {
  console.log('Import : guide des programmes…');
  const xml = await xtream.xmltv();
  const insert = db.prepare('INSERT INTO programmes VALUES (?, ?, ?, ?, ?)');
  const attr = (attrs, name) => (attrs.match(new RegExp(`${name}="([^"]*)"`)) || [])[1] || '';
  const tag = (body, name) => (body.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)) || [])[1] || '';
  let count = 0;

  transaction(() => {
    db.exec('DELETE FROM programmes');
    for (const [, attrs, body] of xml.matchAll(/<programme\s([^>]*)>([\s\S]*?)<\/programme>/g)) {
      const start = parseXmltvDate(attr(attrs, 'start'));
      const stop = parseXmltvDate(attr(attrs, 'stop'));
      const channel = attr(attrs, 'channel').toLowerCase();
      if (!start || !stop || !channel) continue;
      insert.run(channel, start, stop, decodeXml(tag(body, 'title')).trim(), decodeXml(tag(body, 'desc')).trim() || null);
      count++;
    }
    setMeta('epg_synced_at', new Date().toISOString());
  });
  console.log(`Guide : ${count} programmes`);
}

// Rafraîchit le guide s'il date de plus de `maxAgeHours` (il ne couvre que ~3 jours).
function refreshEpgIfStale(maxAgeHours = 6) {
  const syncedAt = getMeta('epg_synced_at');
  // Base vide : le guide sera importé avec le catalogue, depuis l'écran d'accueil.
  if (!getMeta('synced_at') || syncing) return;
  if (syncedAt && Date.now() - new Date(syncedAt) < maxAgeHours * 3600 * 1000) return;
  syncEpg().catch((err) => console.error('Guide :', err.message));
}

let syncing = null;

// Importe tout (catalogue puis guide), en remplaçant le contenu existant.
function sync() {
  syncing ??= (async () => {
    await syncCatalog();
    await syncEpg();
    console.log('Import terminé', counts());
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// Déconnexion : vide toute la base (catalogue, guide, métadonnées).
function reset() {
  if (syncing) throw Object.assign(new Error('Import en cours, réessaie dans quelques secondes'), { status: 409 });
  transaction(() => db.exec('DELETE FROM categories; DELETE FROM items; DELETE FROM programmes; DELETE FROM meta;'));
}

// --- Lecture ---------------------------------------------------------------------

function counts() {
  const rows = db.prepare('SELECT type, COUNT(*) AS n FROM items GROUP BY type').all();
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

function status() {
  const config = xtream.readConfig();
  return {
    configured: !!config,
    account: config && { server: new URL(config.server).host, username: config.username },
    syncing: !!syncing,
    syncedAt: getMeta('synced_at'),
    epgSyncedAt: getMeta('epg_synced_at'),
    counts: counts(),
  };
}

function categories(type) {
  return db.prepare('SELECT id, name FROM categories WHERE type = ? ORDER BY position').all(type);
}

const PAGE_SIZE = 200;

function list({ type, category, q, offset = 0 }) {
  const where = ['type = ?'];
  const params = [type];
  if (category) {
    where.push('category_id = ?');
    params.push(category);
  }
  if (q) {
    where.push('search LIKE ?');
    params.push(`%${normalize(q)}%`);
  }
  return db
    .prepare(`SELECT id, name, logo, category_id AS category, ext, archive_days AS archiveDays
              FROM items WHERE ${where.join(' AND ')} ORDER BY position LIMIT ? OFFSET ?`)
    .all(...params, PAGE_SIZE, Number(offset) || 0);
}

// Format attendu par /timeshift : "AAAA-MM-JJ:HH-mm" dans le fuseau du fournisseur.
function replayStart(timestamp) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: getMeta('timezone') || 'Europe/Paris',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(timestamp * 1000)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}:${parts.hour}-${parts.minute}`;
}

// Pour chaque chaîne de la catégorie : le programme diffusé à `at` et les suivants.
function guide({ category, at, perChannel = 3 }) {
  const rows = db
    .prepare(`SELECT i.id, i.name, i.logo, i.archive_days AS archiveDays,
                     p.start, p.stop, p.title, p.description
              FROM items i JOIN programmes p ON p.channel = i.epg_id
              WHERE i.type = 'live' AND i.category_id = ? AND p.stop > ? AND p.start < ?
              ORDER BY i.position, p.start`)
    .all(category, at, at + 8 * 3600);

  const channels = new Map();
  for (const { id, name, logo, archiveDays, ...programme } of rows) {
    if (!channels.has(id)) channels.set(id, { id, name, logo, archiveDays, programmes: [] });
    const { programmes } = channels.get(id);
    // Le XMLTV contient des doublons (même programme, parfois décalé d'une minute) : on ignore les chevauchements.
    const previous = programmes[programmes.length - 1];
    if (programmes.length >= perChannel || (previous && programme.start < previous.stop)) continue;
    programmes.push({ ...programme, replayStart: replayStart(programme.start) });
  }
  return [...channels.values()];
}

module.exports = { sync, reset, refreshEpgIfStale, needsResync, status, categories, list, guide, PAGE_SIZE };
