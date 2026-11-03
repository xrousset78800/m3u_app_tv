// Base SQLite locale : catalogue (chaînes, films, séries) et guide des programmes,
// importés depuis l'API du fournisseur.

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const xtream = require('./xtream');

const DB_FILE = path.join(xtream.DATA_DIR, 'tv.db');
const db = new DatabaseSync(DB_FILE);

// WAL : la base reste lisible pendant que le guide s'importe dans son fil à part.
db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;');

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
  CREATE INDEX IF NOT EXISTS items_position ON items (type, position);
  CREATE TABLE IF NOT EXISTS programmes (
    channel TEXT NOT NULL,       -- identifiant XMLTV, en minuscules
    start INTEGER NOT NULL,      -- timestamps Unix (secondes)
    stop INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT
  );
  CREATE INDEX IF NOT EXISTS programmes_channel ON programmes (channel, start);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  -- Groupes et éléments retirés par l'utilisateur : à part, car chaque import remplace le catalogue.
  CREATE TABLE IF NOT EXISTS hidden (
    type TEXT NOT NULL,
    kind TEXT NOT NULL,          -- category | item
    id TEXT NOT NULL,
    PRIMARY KEY (type, kind, id)
  );
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

// Le travail lourd se fait dans lib/epg-worker.js : l'appli reste utilisable pendant l'import.
async function importEpg() {
  console.log('Import : guide des programmes…');
  const xml = await xtream.xmltv();
  const count = await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'epg-worker.js'), { workerData: { file: DB_FILE, xml } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  console.log(`Guide : ${count} programmes`);
}

let epgSyncing = null;

function syncEpg() {
  epgSyncing ??= importEpg().finally(() => {
    epgSyncing = null;
  });
  return epgSyncing;
}

// Rafraîchit le guide s'il date de plus de `maxAgeHours` : pas à chaque lancement, c'est un gros
// fichier, mais il ne court que sur une quinzaine d'heures pour la plupart des chaînes.
function refreshEpgIfStale(maxAgeHours = 12) {
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
  if (syncing || epgSyncing) throw Object.assign(new Error('Import en cours, réessaie dans quelques secondes'), { status: 409 });
  transaction(() => db.exec('DELETE FROM categories; DELETE FROM items; DELETE FROM programmes; DELETE FROM meta; DELETE FROM hidden;'));
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

// Élément retiré lui-même, ou dont le groupe est retiré (`i` : nom ou alias de la table items).
const itemHidden = (i) => `EXISTS (SELECT 1 FROM hidden h WHERE h.type = ${i}.type AND h.kind = 'item' AND h.id = ${i}.id)`;
const groupHidden = (i) => `EXISTS (SELECT 1 FROM hidden h WHERE h.type = ${i}.type AND h.kind = 'category' AND h.id = ${i}.category_id)`;
const visible = (i) => `NOT ${itemHidden(i)} AND NOT ${groupHidden(i)}`;
// Fausse chaîne du fournisseur, simple intertitre de sa liste : « ##### FORMULA 1 ##### ».
const separator = (i) => `(${i}.type = 'live' AND ${i}.name GLOB '##*##')`;
// Tri dans l'ordre choisi pour les favoris (paramètre : les identifiants entre virgules, ",12,7,").
const favoriteOrder = (column) => `instr(?, ',' || ${column} || ',')`;

function categories(type) {
  return db
    .prepare(`SELECT id, name FROM categories c
              WHERE type = ? AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.type = c.type AND h.kind = 'category' AND h.id = c.id)
              ORDER BY position`)
    .all(type);
}

// Tous les groupes, retirés ou non, avec leur nombre d'éléments : pour la page de gestion.
function manageCategories(type) {
  return db
    .prepare(`SELECT c.id, c.name, COUNT(i.id) AS total, COUNT(h.id) AS removed,
                     EXISTS (SELECT 1 FROM hidden g WHERE g.type = c.type AND g.kind = 'category' AND g.id = c.id) AS hidden
              FROM categories c
              LEFT JOIN items i ON i.type = c.type AND i.category_id = c.id AND NOT ${separator('i')}
              LEFT JOIN hidden h ON h.type = i.type AND h.kind = 'item' AND h.id = i.id
              WHERE c.type = ?
              GROUP BY c.id
              ORDER BY c.position`)
    .all(type);
}

function setHidden({ type, kind, ids, hidden }) {
  const statement = db.prepare(hidden
    ? 'INSERT OR IGNORE INTO hidden VALUES (?, ?, ?)'
    : 'DELETE FROM hidden WHERE type = ? AND kind = ? AND id = ?');
  transaction(() => ids.forEach((id) => statement.run(type, kind, id)));
}

const PAGE_SIZE = 200;

// `includeHidden` : page de gestion, où l'on doit pouvoir rétablir ce qui a été retiré.
function list({ type, category, ids, q, offset = 0, includeHidden = false }) {
  const where = ['type = ?'];
  const params = [type];
  if (!includeHidden) where.push(visible('items'));
  // Les intertitres n'ont de sens que dans la liste complète, où ils séparent les sections.
  if (includeHidden || ids || q) where.push(`NOT ${separator('items')}`);
  // Et seulement s'ils annoncent encore quelque chose : la ligne visible suivante doit être une vraie chaîne.
  else {
    where.push(`(NOT ${separator('items')} OR (
      SELECT NOT ${separator('n')} FROM items n
      WHERE n.type = items.type AND n.position > items.position AND ${visible('n')}
        ${category ? 'AND n.category_id = items.category_id' : ''}
      ORDER BY n.position LIMIT 1))`);
  }
  if (ids) {
    where.push(`id IN (${ids.map(() => '?').join()})`);
    params.push(...ids);
  } else if (category) {
    where.push('category_id = ?');
    params.push(category);
  }
  if (q) {
    where.push('search LIKE ?');
    params.push(`%${normalize(q)}%`);
  }
  return db
    .prepare(`SELECT id, name, logo, category_id AS category, ext, archive_days AS archiveDays,
                     ${itemHidden('items')} AS hidden, ${groupHidden('items')} AS groupHidden, ${separator('items')} AS separator
              FROM items WHERE ${where.join(' AND ')} ORDER BY ${ids ? favoriteOrder('id') : 'position'} LIMIT ? OFFSET ?`)
    .all(...params, ...(ids ? [`,${ids},`] : []), PAGE_SIZE, Number(offset) || 0);
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
// Avec `ids` (favoris), ces chaînes-là, y compris celles sans guide : on doit pouvoir les retirer.
function guide({ category, ids, at, perChannel = 3 }) {
  const rows = db
    .prepare(`SELECT i.id, i.name, i.logo, i.archive_days AS archiveDays, i.category_id AS category,
                     p.start, p.stop, p.title, p.description
              FROM items i ${ids ? 'LEFT ' : ''}JOIN programmes p ON p.channel = i.epg_id AND p.stop > ? AND p.start < ?
              WHERE i.type = 'live' AND ${visible('i')} AND NOT ${separator('i')} AND ${ids ? `i.id IN (${ids.map(() => '?').join()})` : 'i.category_id = ?'}
              ORDER BY ${ids ? favoriteOrder('i.id') : 'i.position'}, p.start`)
    .all(at, at + 8 * 3600, ...(ids ? [...ids, `,${ids},`] : [category]));

  const channels = new Map();
  for (const { id, name, logo, archiveDays, category: channelCategory, ...programme } of rows) {
    if (!channels.has(id)) channels.set(id, { id, name, logo, archiveDays, category: channelCategory, programmes: [] });
    if (programme.start === null) continue;
    const { programmes } = channels.get(id);
    // Le XMLTV contient des doublons (même programme, parfois décalé d'une minute) : on ignore les chevauchements.
    const previous = programmes[programmes.length - 1];
    if (programmes.length >= perChannel || (previous && programme.start < previous.stop)) continue;
    programmes.push({ ...programme, replayStart: replayStart(programme.start) });
  }
  return [...channels.values()];
}

// Programme d'une chaîne d'après le guide local, au même format que l'API du fournisseur.
function channelProgrammes(id) {
  const rows = db
    .prepare(`SELECT i.archive_days AS archiveDays, p.start, p.stop, p.title, p.description
              FROM items i JOIN programmes p ON p.channel = i.epg_id
              WHERE i.type = 'live' AND i.id = ?
              ORDER BY p.start`)
    .all(String(id));

  const now = Date.now() / 1000;
  const programmes = [];
  for (const { archiveDays, start, stop, title, description } of rows) {
    // Mêmes doublons que dans guide().
    if (programmes.length && start < programmes[programmes.length - 1].end) continue;
    programmes.push({
      title,
      description,
      start,
      end: stop,
      replayStart: replayStart(start),
      archive: stop < now && start > now - archiveDays * 86400,
    });
  }
  return programmes;
}

module.exports = { sync, reset, refreshEpgIfStale, needsResync, status, categories, manageCategories, setHidden, list, guide, channelProgrammes, PAGE_SIZE };
