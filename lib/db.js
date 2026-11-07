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
  -- Réponses de TMDB déjà mises en forme (voir tmdb.js), gardées d'un import à l'autre.
  CREATE TABLE IF NOT EXISTS tmdb (key TEXT PRIMARY KEY, value TEXT, at INTEGER NOT NULL);
  -- Sous-titres téléchargés (voir opensubtitles.js) : chaque téléchargement compte, on les garde.
  CREATE TABLE IF NOT EXISTS subtitles (
    media TEXT NOT NULL,         -- movie:<id> | series:<id> (épisode)
    file_id TEXT NOT NULL,
    language TEXT NOT NULL,
    release TEXT NOT NULL,
    cues TEXT NOT NULL,          -- JSON [{ start, end, text }], en secondes depuis le début du film
    at INTEGER NOT NULL,
    PRIMARY KEY (media, file_id)
  );
  -- Comptes de l'appli (voir profiles.js) : gardés à la déconnexion du fournisseur.
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,          -- admin | child | standard
    password TEXT,               -- scrypt « sel:empreinte » en hexadécimal, NULL : sans mot de passe
    groups TEXT                  -- JSON { live: [ids], vod: [...], series: [...] }, NULL : tous les groupes
  );
`);
// Premier lancement : un seul compte, administrateur et sans mot de passe.
if (!db.prepare('SELECT 1 FROM profiles LIMIT 1').get()) db.prepare("INSERT INTO profiles (name, role) VALUES ('Admin', 'admin')").run();

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
  if (syncing || epgSyncing) throw Object.assign(new Error('Import en cours, réessaie dans quelques secondes'), { status: 409, key: 'importRunning' });
  transaction(() => db.exec('DELETE FROM categories; DELETE FROM items; DELETE FROM programmes; DELETE FROM meta; DELETE FROM hidden; DELETE FROM tmdb;'));
  // Les sous-titres téléchargés restent : souvent on se reconnecte au même abonnement, et chacun a coûté du quota.
}

const savedSubtitles = {
  list(media) {
    return db.prepare('SELECT file_id AS fileId, language, release FROM subtitles WHERE media = ? ORDER BY at').all(media);
  },
  cues(media, fileId) {
    const row = db.prepare('SELECT cues FROM subtitles WHERE media = ? AND file_id = ?').get(media, fileId);
    return row ? JSON.parse(row.cues) : null;
  },
  // Un même fichier déjà téléchargé pour un autre film (doublon du catalogue) ne recoûte rien.
  anyCues(fileId) {
    const row = db.prepare('SELECT cues FROM subtitles WHERE file_id = ? LIMIT 1').get(fileId);
    return row ? JSON.parse(row.cues) : null;
  },
  save(media, { fileId, language, release }, cues) {
    db.prepare('INSERT OR REPLACE INTO subtitles VALUES (?, ?, ?, ?, ?, ?)').run(media, fileId, language, release, JSON.stringify(cues), Date.now());
  },
};

const profiles = {
  all() {
    return db.prepare('SELECT * FROM profiles ORDER BY id').all().map((p) => ({ ...p, groups: p.groups ? JSON.parse(p.groups) : null }));
  },
  get(id) {
    return this.all().find((p) => p.id === Number(id)) || null;
  },
  create({ name, role, password, groups }) {
    return Number(db.prepare('INSERT INTO profiles (name, role, password, groups) VALUES (?, ?, ?, ?)')
      .run(name, role, password, groups && JSON.stringify(groups)).lastInsertRowid);
  },
  update(id, { name, role, password, groups }) {
    db.prepare('UPDATE profiles SET name = ?, role = ?, password = ?, groups = ? WHERE id = ?')
      .run(name, role, password, groups && JSON.stringify(groups), id);
  },
  remove(id) {
    db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
  },
};

const tmdbCache = {
  get(key) {
    const row = db.prepare('SELECT value, at FROM tmdb WHERE key = ?').get(key);
    return row ? { value: JSON.parse(row.value), at: row.at } : null;
  },
  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO tmdb VALUES (?, ?, ?)').run(key, JSON.stringify(value), Date.now());
  },
};

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

// Groupes autorisés d'un compte restreint : `groups`, liste des identifiants pour ce type (undefined : tous).
const allowedGroup = (column) => `${column} IN (SELECT value FROM json_each(?))`;

// Groupes visibles avec leur nombre d'éléments visibles (sans les intertitres) ; un groupe vidé dans les réglages n'apparaît plus.
function categories(type, groups) {
  return db
    .prepare(`SELECT c.id, c.name, COUNT(i.id) AS count FROM categories c
              JOIN items i ON i.type = c.type AND i.category_id = c.id AND NOT ${separator('i')} AND NOT ${itemHidden('i')}
              WHERE c.type = ? AND NOT EXISTS (SELECT 1 FROM hidden h WHERE h.type = c.type AND h.kind = 'category' AND h.id = c.id)
                ${groups ? `AND ${allowedGroup('c.id')}` : ''}
              GROUP BY c.id
              ORDER BY c.position`)
    .all(type, ...(groups ? [JSON.stringify(groups)] : []));
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
// `groups` : compte restreint, seuls ces groupes (voir allowedGroup) ; ses intertitres annonceraient des groupes absents.
function list({ type, category, ids, q, offset = 0, includeHidden = false, groups }) {
  const where = ['type = ?'];
  const params = [type];
  if (!includeHidden) where.push(visible('items'));
  if (groups) {
    where.push(allowedGroup('category_id'));
    params.push(JSON.stringify(groups));
  }
  // Les intertitres n'ont de sens que dans la liste complète, où ils séparent les sections.
  if (includeHidden || ids || q || groups) where.push(`NOT ${separator('items')}`);
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

// Chaîne, film ou série accessible : pas retiré, et dans les groupes du compte s'il est restreint.
function itemAllowed(type, id, groups) {
  const row = db.prepare(`SELECT category_id AS category, ${visible('items')} AS shown FROM items WHERE type = ? AND id = ?`).get(type, String(id));
  return Boolean(row?.shown) && (!groups || groups.includes(row.category));
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

// Les chaînes de list() (catégorie, favoris, recherche, intertitres, par pages),
// chacune avec le programme diffusé à `at` et le suivant, et celui diffusé à `evening` s'il est demandé
// (le reste est dans sa fiche).
function guide({ category, ids, q, offset, at, evening, perChannel = 2, groups }) {
  const channels = list({ type: 'live', category, ids, q, offset, groups }).map(({ id, name, logo, archiveDays, category: group, separator: isSeparator }) => (
    { id, name, logo, archiveDays, category: group, separator: isSeparator, programmes: [], evening: null }
  ));
  const byId = new Map(channels.filter((c) => !c.separator).map((c) => [c.id, c]));
  if (!byId.size) return channels;

  const rows = db
    .prepare(`SELECT i.id, p.start, p.stop, p.title, p.description
              FROM items i JOIN programmes p ON p.channel = i.epg_id AND p.stop > ? AND p.start < ?
              WHERE i.type = 'live' AND i.id IN (${[...byId.keys()].map(() => '?').join()})
              ORDER BY p.start`)
    .all(at, at + 8 * 3600, ...byId.keys());
  for (const { id, ...programme } of rows) {
    const { programmes } = byId.get(id);
    // Le XMLTV contient des doublons (même programme, parfois décalé d'une minute) : on ignore les chevauchements.
    const previous = programmes[programmes.length - 1];
    if (programmes.length >= perChannel || (previous && programme.start < previous.stop)) continue;
    programmes.push({ ...programme, replayStart: replayStart(programme.start) });
  }

  if (evening) {
    const eveningRows = db
      .prepare(`SELECT i.id, p.start, p.stop, p.title, p.description
                FROM items i JOIN programmes p ON p.channel = i.epg_id AND p.start <= ? AND p.stop > ?
                WHERE i.type = 'live' AND i.id IN (${[...byId.keys()].map(() => '?').join()})
                ORDER BY p.start`)
      .all(evening, evening, ...byId.keys());
    for (const { id, ...programme } of eveningRows) {
      const channel = byId.get(id);
      channel.evening ??= { ...programme, replayStart: replayStart(programme.start) };
    }
  }
  return channels;
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

module.exports = { sync, reset, refreshEpgIfStale, needsResync, status, categories, manageCategories, setHidden, list, guide, itemAllowed, channelProgrammes, tmdbCache, savedSubtitles, profiles, PAGE_SIZE };
