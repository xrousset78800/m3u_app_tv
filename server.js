// Serveur local : interface, API du catalogue (SQLite), proxy HLS et conversion ffmpeg.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./lib/db');
const xtream = require('./lib/xtream');
const hls = require('./lib/hls');
const media = require('./lib/media');
const tmdb = require('./lib/tmdb');
const opensubtitles = require('./lib/opensubtitles');
const profiles = require('./lib/profiles');

tmdb.useStore(db.tmdbCache);

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const EPG_REFRESH_DELAY = 15 * 1000;

// --- Fiches détaillées (appel direct à l'API, non stocké) ------------------------
// `language` : langue choisie dans les réglages ; les textes de TMDB y remplacent ceux du fournisseur
// quand il y en a (voir lib/tmdb.js).

// Les champs vides de TMDB laissent ceux du fournisseur.
function overlay(base, extra) {
  for (const [name, value] of Object.entries(extra || {})) if (typeof value === 'string' && value) base[name] = value;
  return base;
}

async function vodInfo(id, language) {
  const { info = {}, movie_data: data = {} } = await xtream.api('get_vod_info', { vod_id: id });
  const translated = await tmdb.movie(info.tmdb_id, language);
  return overlay({
    id,
    name: data.name || info.name,
    ext: data.container_extension,
    cover: info.cover_big || info.movie_image,
    plot: info.plot || info.description || '',
    genre: info.genre || '',
    year: (info.releasedate || '').slice(0, 4),
    duration: info.duration || '',
    rating: Number(info.rating) || null,
    director: info.director || '',
    cast: info.cast || info.actors || '',
    tmdbId: /^\d+$/.test(String(info.tmdb_id || '')) ? String(info.tmdb_id) : '',
  }, translated);
}

// --- Sous-titres en ligne (voir lib/opensubtitles.js) ------------------------------

// Film ou épisode : « movie:12 », « series:34 ».
function mediaKey(kind, id) {
  if (!MEDIA_KINDS.includes(kind) || !/^\d+$/.test(String(id || ''))) throw Object.assign(new Error('Paramètres invalides'), { status: 400 });
  return `${kind}:${id}`;
}

async function searchSubtitles(params) {
  mediaKey(params.get('kind'), params.get('id'));
  const languages = params.get('languages') || '';
  if (!/^[a-z]{2}(-[a-z]{2})?(,[a-z]{2}(-[a-z]{2})?)*$/.test(languages)) throw Object.assign(new Error('Langue invalide'), { status: 400 });
  let tmdbId = /^\d+$/.test(params.get('tmdb') || '') ? params.get('tmdb') : '';
  // Film lancé sans sa fiche (playlist) : l'identifiant TMDB est chez le fournisseur.
  if (!tmdbId && params.get('kind') === 'movie') {
    const { info = {} } = await xtream.api('get_vod_info', { vod_id: params.get('id') }).catch(() => ({}));
    if (/^\d+$/.test(String(info.tmdb_id || ''))) tmdbId = String(info.tmdb_id);
  }
  const title = tmdb.cleanName(params.get('title') || '').replace(/\s+—\s+S\d+E\d+$/, '');
  if (!tmdbId && !title) return [];
  return opensubtitles.search({ tmdbId, title, languages, fps: Number(params.get('fps')) || null });
}

// Déjà téléchargé (pour ce film ou un doublon du catalogue) : ne recoûte rien.
async function downloadSubtitle({ kind, id, fileId, language, release }) {
  const media = mediaKey(kind, id);
  if (!/^\d+$/.test(String(fileId || ''))) throw Object.assign(new Error('Paramètres invalides'), { status: 400 });
  const entry = { fileId: String(fileId), language: String(language || '').slice(0, 10), release: String(release || '').slice(0, 300) };
  let cues = db.savedSubtitles.cues(media, entry.fileId);
  let remaining = null;
  if (!cues) {
    cues = db.savedSubtitles.anyCues(entry.fileId);
    if (!cues) ({ cues, remaining } = await opensubtitles.download(entry.fileId));
    db.savedSubtitles.save(media, entry, cues);
  }
  return { ...entry, cues, remaining };
}

async function seriesInfo(id, language) {
  const { info = {}, episodes = {} } = await xtream.api('get_series_info', { series_id: id });
  const seasons = Object.entries(episodes)
    .map(([number, list]) => ({
      number: Number(number),
      episodes: list.map((e) => ({
        id: e.id,
        num: Number(e.episode_num),
        title: e.title,
        ext: e.container_extension,
        plot: e.info?.plot || '',
        image: e.info?.movie_image || '',
        duration: e.info?.duration || '',
        tmdbId: e.info?.tmdb_id ? String(e.info.tmdb_id) : '',
      })),
    }))
    .sort((a, b) => a.number - b.number);
  const result = {
    id,
    name: info.name,
    cover: info.cover,
    plot: info.plot || '',
    genre: info.genre || '',
    year: (info.releaseDate || '').slice(0, 4),
    rating: Number(info.rating) || null,
    cast: info.cast || '',
    seasons,
  };
  const translated = await tmdb.series(id, result, seasons, language);
  if (translated) {
    const { episodes, ...show } = translated;
    overlay(result, show);
    // Image du fournisseur d'abord : TMDB ne sert qu'à combler un manque.
    for (const e of seasons.flatMap((s) => s.episodes)) {
      const found = episodes[e.tmdbId];
      if (found) overlay(e, { title: found.title, plot: found.plot, image: e.image ? '' : found.image });
    }
  }
  return result; // tmdbId gardé sur les épisodes : il sert à chercher leurs sous-titres
}

const decode = (b64) => Buffer.from(b64 || '', 'base64').toString('utf8');

// "2026-10-21 17:30:00" (heure du serveur) -> "2026-10-21:17-30", format attendu par /timeshift
function replayStart(start) {
  const [date, time = ''] = start.split(' ');
  return `${date}:${time.slice(0, 5).replace(':', '-')}`;
}

// Guide des programmes : passé (pour le replay) et à venir.
const epgCache = new Map();
async function epg(id) {
  const cached = epgCache.get(id);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const { epg_listings: listings = [] } = await xtream.api('get_simple_data_table', { stream_id: id }).catch(() => ({}));
  // Le fournisseur renvoie parfois une liste vide : on se rabat sur le guide local.
  const data = listings.length
    ? listings
        .map((e) => ({
          title: decode(e.title),
          description: decode(e.description),
          start: Number(e.start_timestamp),
          end: Number(e.stop_timestamp),
          replayStart: replayStart(e.start),
          archive: !!Number(e.has_archive),
        }))
        .sort((a, b) => a.start - b.start)
    : db.channelProgrammes(id);
  epgCache.set(id, { at: Date.now(), data });
  return data;
}

// --- HTTP ------------------------------------------------------------------------

// `error` : erreur prévue, dont l'interface affiche le message dans sa langue (en-tête X-Error).
function sendText(res, status, text, error) {
  if (res.headersSent) return res.destroy();
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (error?.key) headers['X-Error'] = encodeURIComponent(JSON.stringify({ key: error.key, vars: error.vars }));
  res.writeHead(status, headers);
  res.end(text);
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readJson(req, limit = 200000) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw Object.assign(new Error('Requête trop volumineuse'), { status: 413 });
  }
  try {
    return JSON.parse(body);
  } catch {
    throw Object.assign(new Error('JSON invalide'), { status: 400 });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function serveStatic(res, pathname) {
  const file = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC_DIR)) return sendText(res, 403, 'Interdit');
  fs.readFile(file, (err, data) => {
    if (err) return sendText(res, 404, 'Introuvable');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const TYPES = ['live', 'vod', 'series'];
const MEDIA_KINDS = ['movie', 'series'];

// Valide les paramètres d'un film/épisode et renvoie l'URL du fournisseur.
function mediaUrl(params) {
  const kind = params.get('kind');
  const id = params.get('id') || '';
  const ext = params.get('ext') || '';
  if (!MEDIA_KINDS.includes(kind) || !/^\d+$/.test(id) || !/^[a-z0-9]{2,4}$/i.test(ext)) {
    throw Object.assign(new Error('Paramètres invalides'), { status: 400 });
  }
  return xtream.urls.media(kind, id, ext);
}

// --- Comptes : ce qu'un compte restreint peut voir ----------------------------------

// Groupes autorisés pour ce type ; undefined pour un compte qui voit tout.
const groupsFor = (profile, type) => (profile.groups ? profile.groups[type] ?? [] : undefined);
const notAllowed = () => Object.assign(new Error('Non autorisé'), { status: 403, key: 'notAllowed' });

function allow(profile, type, id) {
  const groups = groupsFor(profile, type);
  if (groups && !db.itemAllowed(type, id, groups)) throw notAllowed();
}

// Épisode : il doit appartenir à une série autorisée. Ceux des fiches déjà ouvertes sont connus ;
// sinon (reprise depuis la playlist), la liste des épisodes de la série est redemandée.
async function allowMedia(profile, params) {
  if (!profile.groups) return;
  const id = String(params.get('id'));
  if (params.get('kind') === 'movie') return allow(profile, 'vod', id);
  const { episodes } = profile.session;
  if (episodes.has(id)) return;
  const series = params.get('series') || '';
  if (/^\d+$/.test(series)) {
    allow(profile, 'series', series);
    const info = await xtream.api('get_series_info', { series_id: series });
    for (const list of Object.values(info.episodes || {})) for (const e of list) episodes.add(String(e.id));
  }
  if (!episodes.has(id)) throw notAllowed();
}

// Liste d'identifiants (les favoris), absente si le paramètre n'est pas fourni.
function idsParam(params) {
  return params.has('ids') ? params.get('ids').split(',').filter((id) => /^\d+$/.test(id)) : undefined;
}

function codecsParam(params) {
  return (params.get('codecs') || '').split(',');
}

// Accès (4e élément) : 'public' sans compte choisi, 'admin' pour l'administrateur ; sinon tout compte.
const routes = [
  // Compte en cours et écran de choix. Un seul compte, sans mot de passe : il est choisi d'office.
  ['GET', /^\/api\/profiles$/, (req, res, { profile }) => {
    let current = profile && { id: profile.id, name: profile.name, role: profile.role, locked: profile.locked, groups: profile.groups };
    const automatic = !profile && profiles.automatic();
    if (automatic) {
      res.setHeader('Set-Cookie', profiles.open(automatic));
      current = { id: automatic.id, name: automatic.name, role: automatic.role, locked: false, groups: automatic.groups };
    }
    sendJson(res, { current, profiles: profiles.list() });
  }, 'public'],
  ['POST', /^\/api\/profiles\/select$/, async (req, res) => {
    const { id, password } = await readJson(req);
    res.setHeader('Set-Cookie', await profiles.select(id, password));
    sendJson(res, { ok: true });
  }, 'public'],
  ['POST', /^\/api\/profiles\/leave$/, (req, res) => {
    res.setHeader('Set-Cookie', profiles.close(req));
    sendJson(res, { ok: true });
  }, 'public'],
  ['POST', /^\/api\/profiles$/, async (req, res) => sendJson(res, { id: profiles.create(await readJson(req)) }), 'admin'],
  ['PUT', /^\/api\/profiles\/(\d+)$/, async (req, res, { match }) => {
    profiles.update(Number(match[1]), await readJson(req));
    sendJson(res, { ok: true });
  }, 'admin'],
  ['DELETE', /^\/api\/profiles\/(\d+)$/, (req, res, { match, profile }) => {
    profiles.remove(Number(match[1]), profile.id);
    sendJson(res, { ok: true });
  }, 'admin'],
  // Identifiants du fournisseur : pour l'administrateur seulement.
  ['GET', /^\/api\/status$/, (req, res, { profile }) => {
    const status = { ...db.status(), tmdb: tmdb.enabled(), opensubtitles: opensubtitles.enabled(), languages: tmdb.LANGUAGES };
    if (profile.role !== 'admin') delete status.account;
    sendJson(res, status);
  }],
  ['POST', /^\/api\/login$/, async (req, res) => {
    await xtream.login(await readJson(req));
    sendJson(res, db.status());
  }, 'admin'],
  ['POST', /^\/api\/sync$/, async (req, res) => {
    await db.sync();
    sendJson(res, db.status());
  }, 'admin'],
  ['POST', /^\/api\/logout$/, async (req, res) => {
    await media.stopActive();
    db.reset();
    xtream.forgetConfig();
    hls.reset();
    epgCache.clear();
    sendJson(res, db.status());
  }, 'admin'],
  ['GET', /^\/api\/categories$/, (req, res, { params, profile }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.categories(type, groupsFor(profile, type)));
  }],
  ['GET', /^\/api\/list$/, (req, res, { params, profile }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.list({ type, category: params.get('category'), ids: idsParam(params), q: params.get('q'), offset: params.get('offset'), groups: groupsFor(profile, type), sort: params.get('sort') }));
  }],
  // Autres qualités de la chaîne ou du film en cours (bouton ⇄ du lecteur).
  ['GET', /^\/api\/versions$/, (req, res, { params, profile }) => {
    const type = params.get('type');
    if (!['live', 'vod'].includes(type)) return sendText(res, 400, 'Type inconnu');
    allow(profile, type, params.get('id') || '');
    const q = params.has('q') ? params.get('q') : undefined;
    const result = db.versions({ type, id: params.get('id') || '', q, groups: groupsFor(profile, type) });
    if (!result) return sendText(res, 404, 'Introuvable');
    sendJson(res, result);
  }],
  ['GET', /^\/api\/manage\/categories$/, (req, res, { params }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.manageCategories(type));
  }, 'admin'],
  ['GET', /^\/api\/manage\/items$/, (req, res, { params }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.list({ type, category: params.get('category'), q: params.get('q'), offset: params.get('offset'), includeHidden: true }));
  }, 'admin'],
  ['POST', /^\/api\/hidden$/, async (req, res) => {
    const { type, kind, ids, hidden } = await readJson(req);
    if (!TYPES.includes(type) || !['category', 'item'].includes(kind) || !Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
      return sendText(res, 400, 'Paramètres invalides');
    }
    db.setHidden({ type, kind, ids, hidden: Boolean(hidden) });
    sendJson(res, { ok: true });
  }, 'admin'],
  // Sauvegarde et restauration : comptes et éléments retirés (le reste est dans la page, voir app.js).
  ['GET', /^\/api\/backup$/, (req, res) => sendJson(res, db.backup()), 'admin'],
  ['POST', /^\/api\/restore$/, async (req, res) => {
    const input = await readJson(req, 20e6); // des milliers d'éléments retirés, parfois
    const hidden = Array.isArray(input?.hidden) ? input.hidden : null;
    const valid = (h) => TYPES.includes(h?.type) && ['category', 'item'].includes(h.kind) && typeof h.id === 'string';
    if (!hidden?.every(valid)) return sendText(res, 400, 'Sauvegarde invalide', { key: 'badBackup' });
    db.restore({ profiles: profiles.restore(input.profiles), hidden });
    res.setHeader('Set-Cookie', profiles.close(req));
    sendJson(res, { ok: true });
  }, 'admin'],
  ['GET', /^\/api\/guide$/, (req, res, { params, profile }) => {
    const at = Number(params.get('at')) || Math.floor(Date.now() / 1000);
    sendJson(res, db.guide({ category: params.get('category'), ids: idsParam(params), q: params.get('q'), offset: params.get('offset'), at, evening: Number(params.get('evening')) || null, groups: groupsFor(profile, 'live') }));
  }],
  ['GET', /^\/api\/programmes$/, (req, res, { params, profile }) => {
    const at = Number(params.get('at')) || Math.floor(Date.now() / 1000);
    sendJson(res, db.searchProgrammes({ q: params.get('q'), at, groups: groupsFor(profile, 'live') }));
  }],
  ['GET', /^\/api\/vod\/(\d+)$/, async (req, res, { match, params, profile }) => {
    allow(profile, 'vod', match[1]);
    sendJson(res, await vodInfo(match[1], params.get('language')));
  }],
  ['GET', /^\/api\/series\/(\d+)$/, async (req, res, { match, params, profile }) => {
    allow(profile, 'series', match[1]);
    const info = await seriesInfo(match[1], params.get('language'));
    for (const season of info.seasons) for (const e of season.episodes) profile.session.episodes.add(String(e.id));
    sendJson(res, info);
  }],
  ['GET', /^\/api\/epg\/(\d+)$/, async (req, res, { match, profile }) => {
    allow(profile, 'live', match[1]);
    sendJson(res, await epg(match[1]));
  }],
  ['GET', /^\/api\/media\/probe$/, async (req, res, { params, profile }) => {
    await allowMedia(profile, params);
    sendJson(res, await media.probe(mediaUrl(params)));
  }],
  ['GET', /^\/api\/media\/seek$/, async (req, res, { params, profile }) => {
    await allowMedia(profile, params);
    const start = Math.max(0, Number(params.get('start')) || 0);
    const audio = Math.max(0, parseInt(params.get('audio'), 10) || 0);
    sendJson(res, { start: await media.seekPoint(mediaUrl(params), start, { audio, codecs: codecsParam(params) }) });
  }],
  ['GET', /^\/api\/media\/subtitles$/, async (req, res, { params, profile }) => {
    await allowMedia(profile, params);
    sendJson(res, await media.subtitles(
      mediaUrl(params),
      Math.max(0, Number(params.get('start')) || 0),
      Math.max(0, parseInt(params.get('track'), 10) || 0),
      Math.max(0, parseInt(params.get('from'), 10) || 0),
    ));
  }],
  ['GET', /^\/api\/subtitles\/saved$/, (req, res, { params }) => {
    sendJson(res, db.savedSubtitles.list(mediaKey(params.get('kind'), params.get('id'))));
  }],
  ['GET', /^\/api\/subtitles\/cues$/, (req, res, { params }) => {
    const cues = db.savedSubtitles.cues(mediaKey(params.get('kind'), params.get('id')), params.get('file') || '');
    if (!cues) return sendText(res, 404, 'Introuvable');
    sendJson(res, cues);
  }],
  ['GET', /^\/api\/subtitles\/search$/, async (req, res, { params }) => sendJson(res, await searchSubtitles(params))],
  ['POST', /^\/api\/subtitles\/download$/, async (req, res) => sendJson(res, await downloadSubtitle(await readJson(req)))],
  ['GET', /^\/media\/stream$/, async (req, res, { params, profile }) => {
    await allowMedia(profile, params);
    await media.stream(res, mediaUrl(params), {
      start: Math.max(0, Number(params.get('start')) || 0),
      audio: Math.max(0, parseInt(params.get('audio'), 10) || 0),
      codecs: codecsParam(params),
    });
  }],
  ['GET', /^\/live\/(\d+)\.m3u8$/, async (req, res, { match, profile }) => {
    allow(profile, 'live', match[1]);
    await media.stopActive();
    await hls.servePlaylist(res, `live ${match[1]}`, xtream.urls.live(match[1]));
  }],
  // Chaîne dont le fournisseur refuse le HLS (souvent la 4K) : son flux brut, converti comme les films.
  ['GET', /^\/media\/live\/(\d+)$/, async (req, res, { match, params, profile }) => {
    allow(profile, 'live', match[1]);
    await media.stream(res, xtream.urls.liveRaw(match[1]), { live: true, codecs: codecsParam(params) });
  }],
  ['GET', /^\/replay\/(\d+)\.m3u8$/, async (req, res, { match, params, profile }) => {
    allow(profile, 'live', match[1]);
    const start = params.get('start') || '';
    const minutes = parseInt(params.get('minutes'), 10);
    if (!/^\d{4}-\d{2}-\d{2}:\d{2}-\d{2}$/.test(start) || !(minutes > 0)) return sendText(res, 400, 'Paramètres invalides');
    await media.stopActive();
    await hls.servePlaylist(res, `replay ${match[1]} ${start}`, xtream.urls.replay(match[1], start, minutes));
  }],
  ['GET', /^\/proxy$/, (req, res, { params }) => hls.serveProxy(res, params.get('u'))],
  ['GET', /^\/vendor\/hls\.min\.js$/, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    fs.createReadStream(require.resolve('hls.js/dist/hls.min.js')).pipe(res);
  }, 'public'],
];

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams: params } = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const [method, pattern, handler, access] of routes) {
      const match = pathname.match(pattern);
      if (!match || req.method !== method) continue;
      const profile = profiles.fromRequest(req);
      if (access !== 'public' && !profile) return sendText(res, 401, 'Aucun compte choisi', { key: 'noProfile' });
      if (access === 'admin' && profile.role !== 'admin') return sendText(res, 403, "Réservé à l'administrateur", { key: 'adminOnly' });
      return await handler(req, res, { match, params, profile });
    }
    if (req.method === 'GET') return serveStatic(res, decodeURIComponent(pathname));
    sendText(res, 404, 'Introuvable');
  } catch (err) {
    if (err.name === 'AbortError') return;
    // « fetch failed » seul ne dit rien : le motif réseau (connexion refusée, coupée…) est dans `cause`.
    const cause = err.cause?.code || err.cause?.name;
    const message = cause && !err.message.includes(cause) ? `${err.message} : ${cause}` : err.message;
    console.error(`${pathname} :`, message);
    sendText(res, err.status || 502, message, err);
  }
});

// Démarre le serveur (sur 127.0.0.1 uniquement) et renvoie le port utilisé.
function start(port = PORT) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { counts, syncedAt, configured } = db.status();
      console.log(syncedAt ? `Catalogue en base (import du ${syncedAt}) :` : 'Base vide : lancer l\'import depuis l\'interface', counts);
      console.log(`Lecteur prêt : http://localhost:${server.address().port}`);

      // Base d'avant le guide des programmes : on réimporte une fois pour lier chaînes et guide.
      if (db.needsResync && configured && syncedAt) {
        db.sync().catch((err) => console.error('Import :', err.message));
      } else {
        // Plus tard : le lancement passe d'abord.
        setTimeout(() => db.refreshEpgIfStale(), EPG_REFRESH_DELAY).unref();
      }
      setInterval(() => db.refreshEpgIfStale(), 60 * 60 * 1000).unref();
      resolve(server.address().port);
    });
  });
}

// Arrêt : ffmpeg est un processus à part, il ne s'arrête pas tout seul avec l'appli.
function stop() {
  media.stopActive();
  server.close();
}

if (require.main === module) start();

module.exports = { start, stop };
