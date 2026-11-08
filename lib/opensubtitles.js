// Sous-titres téléchargés depuis OpenSubtitles (opensubtitles.com), pour les films et épisodes
// dont le fichier n'a pas la bonne piste, ou une piste mal calée.
//
// Recherche par identifiant TMDB (donné par le fournisseur), sinon par titre. La recherche est libre ;
// seuls les téléchargements sont comptés, par adresse internet (5 par jour sans compte) : chaque
// sous-titre téléchargé est donc gardé dans la base locale, et n'est plus jamais redemandé.
//
// La clé n'est pas dans le dépôt : variable OPENSUBTITLES_KEY, ou fichier opensubtitles.key (ignoré
// par git, écrit au moment de fabriquer l'installateur à partir d'un secret GitHub).

const fs = require('node:fs');
const path = require('node:path');
const { parseVtt } = require('./media');
const { version } = require('../package.json');

const API = process.env.OPENSUBTITLES_API || 'https://api.opensubtitles.com/api/v1';
const TIMEOUT = 10000;
const SEARCH_CACHE = 3600 * 1000;

const key = (() => {
  if (process.env.OPENSUBTITLES_KEY) return process.env.OPENSUBTITLES_KEY.trim();
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'opensubtitles.key'), 'utf8').trim();
  } catch {
    return '';
  }
})();

const fail = (status, error, vars) => Object.assign(new Error(error), { status, key: error, vars });

// OpenSubtitles demande un nom d'appli et sa version dans chaque requête.
async function call(route, { params, body } = {}, retried = false) {
  const url = new URL(API + route);
  // Paramètres triés et en minuscules : sinon l'API répond par une redirection.
  for (const name of Object.keys(params || {}).sort()) url.searchParams.set(name, String(params[name]).toLowerCase());
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { 'Api-Key': key, 'User-Agent': `TV v${version}`, Accept: 'application/json', ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  }).catch(() => {
    throw fail(502, 'subtitlesUnreachable');
  });
  // Quelques requêtes par seconde au plus : on retente une fois un peu plus tard.
  if (res.status === 429 && !retried) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return call(route, { params, body }, true);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 406 || (route === '/download' && res.ok && !data.link)) {
    const reset = Date.parse(data.reset_time_utc);
    const time = Number.isFinite(reset) ? new Date(reset).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '?';
    throw fail(429, 'subtitlesQuota', { time });
  }
  if (res.status === 401 || res.status === 403) throw fail(502, 'subtitlesKey');
  if (!res.ok) {
    console.log(`[opensubtitles] HTTP ${res.status} sur ${route}`);
    throw fail(502, 'subtitlesUnreachable');
  }
  return data;
}

const searches = new Map();

// `tmdbId` : film ou épisode. Rangés du plus sûr au moins sûr : même vitesse d'images que le fichier,
// traduits par un humain, complets (pas seulement les passages en langue étrangère), puis les plus téléchargés.
async function search({ tmdbId, title, episode, languages, fps }) {
  if (!key) throw fail(503, 'subtitlesKey');
  const params = {
    languages,
    ...(tmdbId
      ? { tmdb_id: tmdbId }
      : { query: title, ...(episode && { type: 'episode', season_number: episode.season, episode_number: episode.episode }) }),
  };
  const name = JSON.stringify(params);
  const hit = searches.get(name);
  const data = hit && Date.now() - hit.at < SEARCH_CACHE ? hit.data : await call('/subtitles', { params });
  searches.set(name, { at: Date.now(), data });

  const speed = (s) => (!fps || !s.fps ? 1 : Math.abs(s.fps - fps) < 0.01 ? 0 : 2); // 0 même, 1 inconnue, 2 autre
  return (data.data || [])
    .map(({ attributes: a }) => ({
      fileId: String(a.files?.[0]?.file_id || ''),
      language: a.language || '',
      release: a.release || a.files?.[0]?.file_name || '',
      fps: a.fps || null,
      speed: speed(a),
      downloads: a.download_count || 0,
      hearingImpaired: !!a.hearing_impaired,
      foreignOnly: !!a.foreign_parts_only,
      automatic: !!(a.ai_translated || a.machine_translated),
      parts: a.files?.length || 0,
    }))
    .filter((s) => s.fileId && s.parts === 1) // un film en plusieurs fichiers (CD1, CD2) : inutilisable ici
    .sort((a, b) => a.speed - b.speed || a.automatic - b.automatic || a.foreignOnly - b.foreignOnly || b.downloads - a.downloads)
    .slice(0, 40);
}

// Texte du fichier : UTF-8 le plus souvent, sinon l'ancien encodage Windows des sous-titres européens.
function decode(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

// Converti en WebVTT par OpenSubtitles, quel que soit le format d'origine.
async function download(fileId) {
  if (!key) throw fail(503, 'subtitlesKey');
  const data = await call('/download', { body: { file_id: Number(fileId), sub_format: 'webvtt' } });
  const res = await fetch(data.link, { signal: AbortSignal.timeout(TIMEOUT) }).catch(() => null);
  if (!res?.ok) throw fail(502, 'subtitlesUnreachable');
  const cues = parseVtt(decode(Buffer.from(await res.arrayBuffer())));
  if (!cues.length) throw fail(502, 'subtitlesEmpty');
  return { cues, remaining: Number.isFinite(data.remaining) ? data.remaining : null };
}

module.exports = { enabled: () => Boolean(key), search, download };
