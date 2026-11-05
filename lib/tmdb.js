// Fiches traduites depuis TMDB (themoviedb.org) : titres et résumés des films, séries et épisodes,
// dans la langue choisie. Les textes du fournisseur, souvent mélangés (français, anglais, allemand
// selon les saisons), restent affichés dès que TMDB n'a rien de sûr : pas de clé, pas d'identifiant,
// pas de traduction, ou pas de réponse.
//
// La clé n'est pas dans le dépôt : variable TMDB_KEY, ou fichier tmdb.key (ignoré par git,
// écrit au moment de fabriquer l'installateur à partir d'un secret GitHub).

const fs = require('node:fs');
const path = require('node:path');

const API = process.env.TMDB_API || 'https://api.themoviedb.org/3';
const IMAGES = 'https://image.tmdb.org/t/p/';
const TIMEOUT = 5000;
const DAY = 24 * 3600 * 1000;
const LANGUAGES = { 'fr-FR': 'Français', 'en-US': 'English', 'de-DE': 'Deutsch', 'es-ES': 'Español', 'it-IT': 'Italiano', 'pt-PT': 'Português' };

const key = (() => {
  if (process.env.TMDB_KEY) return process.env.TMDB_KEY.trim();
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'tmdb.key'), 'utf8').trim();
  } catch {
    return '';
  }
})();

// Clé courte (v3) en paramètre, jeton d'accès (v4, bien plus long) en en-tête : TMDB accepte les deux.
async function get(route, params = {}) {
  const url = new URL(API + route);
  for (const [name, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(name, value);
  const headers = { accept: 'application/json' };
  if (key.length > 40) headers.authorization = `Bearer ${key}`;
  else url.searchParams.set('api_key', key);
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) throw new Error(`TMDB ${res.status} sur ${route}`);
  return res.json();
}

// Cache : la base locale (voir db.js), branchée par le serveur.
let store = { get: () => null, set: () => {} };
function useStore(s) {
  store = s;
}
async function cached(name, maxAge, compute) {
  const hit = store.get(name);
  if (hit && Date.now() - hit.at < maxAge) return hit.value;
  const value = await compute();
  store.set(name, value);
  return value;
}

let warned = false;
function fallback(err) {
  if (!warned || !/TMDB 401/.test(err.message)) console.log(`[tmdb] ${err.message} : textes du fournisseur`);
  if (/TMDB 401/.test(err.message)) warned = true; // clé refusée : un seul message
  return null;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
// Sans traduction, TMDB invente un « Épisode 5 » : le titre du fournisseur vaut mieux.
const placeholder = (name) => /^(é|e)pisod(e|io)\s*\d+$|^folge\s*\d+$/i.test(name);

function wanted(language) {
  return Boolean(key) && Object.hasOwn(LANGUAGES, language);
}

// Film : le fournisseur donne directement l'identifiant TMDB.
async function movie(tmdbId, language) {
  if (!wanted(language) || !/^\d+$/.test(String(tmdbId || ''))) return null;
  try {
    return await cached(`movie:${tmdbId}:${language}`, 30 * DAY, async () => {
      const m = await get(`/movie/${tmdbId}`, { language });
      return { name: text(m.title), plot: text(m.overview), genre: (m.genres || []).map((g) => g.name).join(', ') };
    });
  } catch (err) {
    return fallback(err);
  }
}

// « FR - South Park (1997) [MULTI-SUB] » → « South Park ».
function cleanName(name) {
  return text(name)
    .replace(/^[A-Z]{2,4}\s*[-|:]\s*/, '')
    .replace(/\[[^\]]*\]|\(\d{4}\)/g, '')
    .replace(/\s+-\s+\d{4}$/, '')
    .trim();
}

// Série : le fournisseur ne donne que les identifiants TMDB des épisodes. On cherche la série
// par son nom, et on ne la retient que si ses épisodes portent ces identifiants : pas d'erreur
// de série homonyme, et chaque épisode est retrouvé même quand la numérotation diffère.
async function findSeries(providerId, name, year, sample) {
  return cached(`series-match:${providerId}`, 30 * DAY, async () => {
    const query = cleanName(name);
    if (!query) return null;
    let { results = [] } = await get('/search/tv', { query, first_air_date_year: year });
    if (!results.length && year) ({ results = [] } = await get('/search/tv', { query }));
    for (const candidate of results.slice(0, 3)) {
      const show = await get(`/tv/${candidate.id}`, { append_to_response: `season/${sample.season}` });
      const episodes = show[`season/${sample.season}`]?.episodes || [];
      if (episodes.some((e) => sample.ids.has(String(e.id)))) return candidate.id;
    }
    return null;
  });
}

async function series(providerId, info, seasons, language) {
  if (!wanted(language)) return null;
  const withIds = seasons.map((s) => ({ season: s.number, ids: new Set(s.episodes.map((e) => e.tmdbId).filter(Boolean)) }));
  const sample = withIds.find((s) => s.ids.size);
  if (!sample) return null;
  try {
    const tmdbId = await findSeries(providerId, info.name, info.year, sample);
    if (!tmdbId) return null;
    return await cached(`series:${tmdbId}:${language}:${withIds.map((s) => s.season).join(',')}`, 7 * DAY, async () => {
      // Les saisons par 20 au plus, la limite de TMDB pour append_to_response.
      const numbers = withIds.map((s) => s.season);
      let show = null;
      const episodes = {};
      for (let i = 0; i < numbers.length; i += 20) {
        const chunk = numbers.slice(i, i + 20);
        const part = await get(`/tv/${tmdbId}`, { language, append_to_response: chunk.map((n) => `season/${n}`).join() });
        show ??= part;
        for (const n of chunk) {
          for (const e of part[`season/${n}`]?.episodes || []) {
            const name = text(e.name);
            episodes[e.id] = {
              title: placeholder(name) ? '' : name,
              plot: text(e.overview),
              image: e.still_path ? `${IMAGES}w300${e.still_path}` : '',
            };
          }
        }
      }
      return { name: text(show.name), plot: text(show.overview), genre: (show.genres || []).map((g) => g.name).join(', '), episodes };
    });
  } catch (err) {
    return fallback(err);
  }
}

module.exports = { LANGUAGES, enabled: () => Boolean(key), useStore, movie, series, cleanName };
