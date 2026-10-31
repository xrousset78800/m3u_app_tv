// Serveur local : interface, API du catalogue (SQLite), proxy HLS et conversion ffmpeg.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const db = require('./lib/db');
const xtream = require('./lib/xtream');
const hls = require('./lib/hls');
const media = require('./lib/media');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');

// --- Fiches détaillées (appel direct à l'API, non stocké) ------------------------

async function vodInfo(id) {
  const { info = {}, movie_data: data = {} } = await xtream.api('get_vod_info', { vod_id: id });
  return {
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
  };
}

async function seriesInfo(id) {
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
      })),
    }))
    .sort((a, b) => a.number - b.number);
  return {
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
  const { epg_listings: listings = [] } = await xtream.api('get_simple_data_table', { stream_id: id });
  const data = listings
    .map((e) => ({
      title: decode(e.title),
      description: decode(e.description),
      start: Number(e.start_timestamp),
      end: Number(e.stop_timestamp),
      replayStart: replayStart(e.start),
      archive: !!Number(e.has_archive),
    }))
    .sort((a, b) => a.start - b.start);
  epgCache.set(id, { at: Date.now(), data });
  return data;
}

// --- HTTP ------------------------------------------------------------------------

function sendText(res, status, text) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function sendJson(res, data) {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

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

const routes = [
  ['GET', /^\/api\/status$/, (req, res) => sendJson(res, db.status())],
  ['POST', /^\/api\/sync$/, async (req, res, { params }) => {
    await db.sync(params.get('m3u') || undefined);
    sendJson(res, db.status());
  }],
  ['POST', /^\/api\/logout$/, async (req, res) => {
    await media.stopActive();
    db.reset();
    xtream.forgetConfig();
    hls.reset();
    epgCache.clear();
    sendJson(res, db.status());
  }],
  ['GET', /^\/api\/categories$/, (req, res, { params }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.categories(type));
  }],
  ['GET', /^\/api\/list$/, (req, res, { params }) => {
    const type = params.get('type');
    if (!TYPES.includes(type)) return sendText(res, 400, 'Type inconnu');
    sendJson(res, db.list({ type, category: params.get('category'), q: params.get('q'), offset: params.get('offset') }));
  }],
  ['GET', /^\/api\/guide$/, (req, res, { params }) => {
    const at = Number(params.get('at')) || Math.floor(Date.now() / 1000);
    sendJson(res, db.guide({ category: params.get('category') || '', at }));
  }],
  ['GET', /^\/api\/vod\/(\d+)$/, async (req, res, { match }) => sendJson(res, await vodInfo(match[1]))],
  ['GET', /^\/api\/series\/(\d+)$/, async (req, res, { match }) => sendJson(res, await seriesInfo(match[1]))],
  ['GET', /^\/api\/epg\/(\d+)$/, async (req, res, { match }) => sendJson(res, await epg(match[1]))],
  ['GET', /^\/api\/media\/probe$/, async (req, res, { params }) => sendJson(res, await media.probe(mediaUrl(params)))],
  ['GET', /^\/media\/stream$/, async (req, res, { params }) => {
    await media.stream(res, mediaUrl(params), {
      start: Math.max(0, Number(params.get('start')) || 0),
      audio: Math.max(0, parseInt(params.get('audio'), 10) || 0),
      hevc: params.get('hevc') === '1',
    });
  }],
  ['GET', /^\/live\/(\d+)\.m3u8$/, async (req, res, { match }) => {
    await media.stopActive();
    await hls.servePlaylist(res, `live ${match[1]}`, xtream.urls.live(match[1]));
  }],
  ['GET', /^\/replay\/(\d+)\.m3u8$/, async (req, res, { match, params }) => {
    const start = params.get('start') || '';
    const minutes = parseInt(params.get('minutes'), 10);
    if (!/^\d{4}-\d{2}-\d{2}:\d{2}-\d{2}$/.test(start) || !(minutes > 0)) return sendText(res, 400, 'Paramètres invalides');
    await media.stopActive();
    await hls.servePlaylist(res, `replay ${match[1]} ${start}`, xtream.urls.replay(match[1], start, minutes));
  }],
  ['GET', /^\/proxy$/, (req, res, { params }) => hls.serveProxy(res, params.get('u'))],
];

const server = http.createServer(async (req, res) => {
  const { pathname, searchParams: params } = new URL(req.url, `http://${req.headers.host}`);
  try {
    for (const [method, pattern, handler] of routes) {
      const match = pathname.match(pattern);
      if (match && req.method === method) return await handler(req, res, { match, params });
    }
    if (req.method === 'GET') return serveStatic(res, decodeURIComponent(pathname));
    sendText(res, 404, 'Introuvable');
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(`${pathname} :`, err.message);
    sendText(res, err.status || 502, err.message);
  }
});

server.listen(PORT, () => {
  const { counts, syncedAt, configured } = db.status();
  console.log(syncedAt ? `Catalogue en base (import du ${syncedAt}) :` : 'Base vide : lancer l\'import depuis l\'interface', counts);
  console.log(`Lecteur prêt : http://localhost:${PORT}`);

  // Base d'avant le guide des programmes : on réimporte une fois pour lier chaînes et guide.
  if (db.needsResync && configured && syncedAt) {
    db.sync().catch((err) => console.error('Import :', err.message));
  } else {
    db.refreshEpgIfStale();
  }
  setInterval(() => db.refreshEpgIfStale(), 60 * 60 * 1000);
});
