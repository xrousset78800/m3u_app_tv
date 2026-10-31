const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const details = $('details');
const list = $('list');
const categorySelect = $('category');
const searchInput = $('search');
const seekBar = $('seek-bar');
const audioSelect = $('audio-track');

const DEFAULT_LIVE_CATEGORY = 'FRANCE HD';
// Le navigateur sait-il lire le HEVC ? Sinon le serveur le réencode en H.264.
const HEVC = video.canPlayType('video/mp4; codecs="hvc1.1.6.L120.90"') ? 1 : 0;

let currentType = 'live';
let offset = 0;

// --- Utilitaires ----------------------------------------------------------------

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const formatHour = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// Position de lecture mémorisée (films et épisodes), propre à ce navigateur.
const progress = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(`progress:${key}`)) || null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`progress:${key}`, JSON.stringify(value));
    } catch {}
  },
};

// --- Lecteur --------------------------------------------------------------------

let hls = null;
let media = null; // film/épisode en cours : { kind, id, ext, title, key, duration, start, audio }
let seeking = false;
let lastSave = 0;

function stopPlayback() {
  if (hls) hls.destroy();
  hls = null;
  media = null;
  video.removeAttribute('src');
  video.load();
  video.classList.remove('media');
  $('seek').hidden = true;
}

// Direct et replay : HLS via le proxy du serveur.
function playHls(src, label) {
  stopPlayback();
  setStatus(`Chargement de ${label}…`);
  if (window.Hls && Hls.isSupported()) {
    hls = new Hls({ liveSyncDurationCount: 3 });
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.FRAG_BUFFERED, () => setStatus(`▶ ${label}`));
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      const code = data.response?.code ? ` (HTTP ${data.response.code})` : '';
      setStatus(`Erreur ${data.details}${code} — voir la console du serveur`, true);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
  } else {
    setStatus('Ce navigateur ne sait pas lire le HLS.', true);
  }
}

// Films et épisodes : MP4 produit par ffmpeg, relancé à chaque déplacement.
async function playMedia(item, start = 0) {
  stopPlayback();
  setStatus(`Analyse de ${item.title}…`);
  const query = new URLSearchParams({ kind: item.kind, id: item.id, ext: item.ext });
  let info;
  try {
    info = await getJson(`/api/media/probe?${query}`);
  } catch (err) {
    return setStatus(`Lecture impossible : ${err.message}`, true);
  }

  // Piste française par défaut si elle existe.
  const french = info.audio.findIndex((a) => /^fr/.test(a.lang) || /\bVF/i.test(a.title));
  media = { ...item, duration: info.duration || 0, audio: Math.max(0, french) };
  audioSelect.replaceChildren(
    ...info.audio.map((a, i) =>
      new Option([a.title, a.lang, a.codec, a.channels].filter(Boolean).join(' · ') || `Piste ${i + 1}`, i),
    ),
  );
  audioSelect.value = media.audio;
  audioSelect.hidden = info.audio.length < 2;
  seekBar.max = Math.floor(media.duration);
  $('time-total').textContent = formatTime(media.duration);
  $('seek').hidden = false;
  video.classList.add('media');
  startMediaAt(start);
}

function startMediaAt(start) {
  media.start = Math.max(0, Math.min(start, media.duration - 5));
  const query = new URLSearchParams({
    kind: media.kind, id: media.id, ext: media.ext,
    start: Math.floor(media.start), audio: media.audio, hevc: HEVC,
  });
  setStatus(`Chargement de ${media.title}…`);
  video.src = `/media/stream?${query}`;
  video.play().catch(() => {});
  updateSeek();
}

function position() {
  return media ? media.start + video.currentTime : 0;
}

function updateSeek() {
  if (!media || seeking) return;
  seekBar.value = Math.floor(position());
  $('time-current').textContent = formatTime(position());
}

video.addEventListener('playing', () => {
  if (media) setStatus(`▶ ${media.title}`);
});

video.addEventListener('timeupdate', () => {
  updateSeek();
  if (!media || Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  progress.set(media.key, { position: position(), duration: media.duration });
});

video.addEventListener('ended', () => {
  if (!media) return;
  progress.set(media.key, { position: media.duration, duration: media.duration });
  media.onEnded?.();
});

video.addEventListener('error', () => {
  if (media) setStatus('Le flux s\'est interrompu — voir la console du serveur', true);
});

seekBar.addEventListener('input', () => {
  seeking = true;
  $('time-current').textContent = formatTime(seekBar.value);
});
seekBar.addEventListener('change', () => {
  seeking = false;
  if (media) startMediaAt(Number(seekBar.value));
});
audioSelect.addEventListener('change', () => {
  if (!media) return;
  media.audio = Number(audioSelect.value);
  startMediaAt(position());
});

// Plein écran sur tout le lecteur (vidéo + barre de position + piste audio).
const player = $('player');
let idleTimer;

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else player.requestFullscreen().catch((err) => setStatus(`Plein écran refusé : ${err.message}`, true));
}

// En plein écran, les contrôles s'effacent après 3 s sans mouvement de souris.
function wakeControls() {
  player.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement) idleTimer = setTimeout(() => player.classList.add('idle'), 3000);
}

$('fullscreen').onclick = toggleFullscreen;
video.addEventListener('dblclick', toggleFullscreen);
player.addEventListener('mousemove', wakeControls);
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? '✕ Quitter' : '⛶ Plein écran';
  wakeControls();
});
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'f' && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) toggleFullscreen();
});

// --- TV : direct, guide des programmes et replay -----------------------------------

function playReplay(channel, programme) {
  const minutes = Math.ceil((programme.stop - programme.start) / 60);
  const query = new URLSearchParams({ start: programme.replayStart, minutes });
  playHls(`/replay/${channel.id}.m3u8?${query}`, `${channel.name} — ${programme.title} (replay)`);
}

// `replay` (optionnel) : programme à revoir au lieu du direct.
async function showChannel(channel, replay) {
  if (replay) playReplay(channel, replay);
  else playHls(`/live/${channel.id}.m3u8`, channel.name);
  details.replaceChildren(el('h2', {}, channel.name), el('p', { className: 'muted' }, 'Chargement du programme…'));

  let programs;
  try {
    programs = await getJson(`/api/epg/${channel.id}`);
  } catch {
    programs = [];
  }
  if (!programs.length) {
    details.replaceChildren(el('h2', {}, channel.name), el('p', { className: 'muted' }, 'Pas de guide des programmes pour cette chaîne.'));
    return;
  }

  const now = Date.now() / 1000;
  const dayKey = (ts) => new Date(ts * 1000).toDateString();
  const days = [...new Set(programs.map((p) => dayKey(p.start)))];
  const today = new Date().toDateString();
  const tabs = el('div', { className: 'days' });
  const listEl = el('ul', { className: 'epg' });

  function renderDay(day) {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.day === day));
    listEl.replaceChildren(
      ...programs.filter((p) => dayKey(p.start) === day).map((p) => {
        const current = p.start <= now && p.end > now;
        const canReplay = p.archive && p.start < now;
        const li = el(
          'li',
          { className: current ? 'current' : p.end < now ? 'past' : '' },
          el('span', { className: 'time' }, formatHour(p.start)),
          el(
            'div',
            { className: 'program' },
            el('strong', {}, p.title),
            current && el('div', { className: 'bar' }, el('div', { style: `width:${((now - p.start) / (p.end - p.start)) * 100}%` })),
            el('p', { className: 'description', hidden: true }, p.description),
          ),
          canReplay &&
            el('button', {
              className: 'secondary',
              textContent: current ? '⟲ Depuis le début' : '▶ Revoir',
              onclick: (e) => {
                e.stopPropagation();
                playReplay(channel, { ...p, stop: p.end });
              },
            }),
        );
        li.onclick = () => {
          const description = li.querySelector('.description');
          description.hidden = !description.hidden;
        };
        return li;
      }),
    );
    listEl.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }

  tabs.append(
    ...days.map((day) => {
      const button = el('button', {
        className: 'secondary',
        textContent: day === today ? "Aujourd'hui" : new Date(day).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }),
        onclick: () => renderDay(day),
      });
      button.dataset.day = day;
      return button;
    }),
  );
  details.replaceChildren(
    el('div', { className: 'detail-head' },
      el('h2', {}, channel.name),
      el('button', { className: 'secondary', textContent: '● Direct', onclick: () => playHls(`/live/${channel.id}.m3u8`, channel.name) }),
    ),
    tabs,
    listEl,
  );
  renderDay(days.includes(today) ? today : days[days.length - 1]);
}

// --- Films -------------------------------------------------------------------------

function resumeButtons(item) {
  const saved = progress.get(item.key);
  const inProgress = saved && saved.position > 30 && saved.position < saved.duration * 0.95;
  return [
    el('button', {
      textContent: inProgress ? `▶ Reprendre à ${formatTime(saved.position)}` : '▶ Lire',
      onclick: () => playMedia(item, inProgress ? saved.position : 0),
    }),
    inProgress && el('button', { className: 'secondary', textContent: 'Depuis le début', onclick: () => playMedia(item, 0) }),
  ];
}

function infoBlock(info, buttons) {
  const meta = [info.year, info.genre, info.duration, info.rating && `★ ${info.rating}`].filter(Boolean).join(' · ');
  return el(
    'div',
    { className: 'info' },
    info.cover && el('img', { src: info.cover, className: 'cover', onerror: (e) => e.target.remove() }),
    el(
      'div',
      {},
      el('h2', {}, info.name),
      meta && el('p', { className: 'muted' }, meta),
      el('div', { className: 'buttons' }, ...buttons),
      el('p', {}, info.plot),
      info.director && el('p', { className: 'muted' }, `Réalisation : ${info.director}`),
      info.cast && el('p', { className: 'muted' }, `Avec : ${info.cast}`),
    ),
  );
}

async function showMovie(movie) {
  details.replaceChildren(el('p', { className: 'muted' }, 'Chargement…'));
  const info = await getJson(`/api/vod/${movie.id}`).catch(() => ({ name: movie.name, cover: movie.logo }));
  const item = { kind: 'movie', id: movie.id, ext: info.ext || movie.ext, title: info.name || movie.name, key: `movie:${movie.id}` };
  details.replaceChildren(infoBlock(info, resumeButtons(item)));
}

// --- Séries ------------------------------------------------------------------------

async function showSeries(series) {
  details.replaceChildren(el('p', { className: 'muted' }, 'Chargement…'));
  const info = await getJson(`/api/series/${series.id}`);
  const seasonSelect = el('select', { className: 'season' });
  const episodesEl = el('ul', { className: 'episodes' });

  const allEpisodes = info.seasons.flatMap((s) =>
    s.episodes.map((e) => ({
      ...e,
      season: s.number,
      item: {
        kind: 'series',
        id: e.id,
        ext: e.ext,
        title: `${info.name} — S${String(s.number).padStart(2, '0')}E${String(e.num).padStart(2, '0')}`,
        key: `episode:${e.id}`,
      },
    })),
  );
  // Enchaîne automatiquement sur l'épisode suivant.
  allEpisodes.forEach((e, i) => {
    const next = allEpisodes[i + 1];
    if (next) e.item.onEnded = () => playMedia(next.item);
  });

  function renderSeason(number) {
    episodesEl.replaceChildren(
      ...allEpisodes.filter((e) => e.season === number).map((e) => {
        const saved = progress.get(e.item.key);
        const watched = saved && saved.position >= saved.duration * 0.95;
        return el(
          'li',
          { className: watched ? 'watched' : '' },
          e.image && el('img', { src: e.image, loading: 'lazy', onerror: (ev) => ev.target.remove() }),
          el(
            'div',
            { className: 'program' },
            el('strong', {}, `${e.num}. ${e.title.replace(/^.* - S\d+E\d+ - /, '')}`),
            el('p', { className: 'muted' }, [e.duration, watched && 'vu'].filter(Boolean).join(' · ')),
            el('p', { className: 'description' }, e.plot),
          ),
          el('div', { className: 'buttons' }, ...resumeButtons(e.item)),
        );
      }),
    );
  }

  seasonSelect.append(...info.seasons.map((s) => new Option(`Saison ${s.number} (${s.episodes.length} épisodes)`, s.number)));
  seasonSelect.onchange = () => renderSeason(Number(seasonSelect.value));
  details.replaceChildren(infoBlock(info, [seasonSelect]), episodesEl);
  if (info.seasons.length) renderSeason(info.seasons[0].number);
  else episodesEl.append(el('li', { className: 'muted' }, 'Aucun épisode disponible.'));
}

// --- Programme : grille des chaînes d'une catégorie ----------------------------------

// Soirée : 21h15 pour tomber sur le programme de début de soirée (souvent 21h10).
function evening(daysFromToday) {
  const date = new Date();
  date.setDate(date.getDate() + daysFromToday);
  date.setHours(21, 15, 0, 0);
  return Math.floor(date / 1000);
}

const GUIDE_TIMES = {
  now: { label: 'En ce moment', at: () => Math.floor(Date.now() / 1000) },
  tonight: { label: 'Ce soir', at: () => evening(0) },
  tomorrow: { label: 'Demain soir', at: () => evening(1) },
};
let guideTime = 'now';
let guideTimer;

// Ouvre la chaîne dans l'onglet TV, en direct ou en replay d'un programme passé.
async function watchChannel(channel, replay) {
  await selectType('live', $('guide-category').value);
  const items = [...list.children];
  const match = items.find((li) => li.dataset.id === String(channel.id));
  match?.classList.add('active');
  match?.scrollIntoView({ block: 'center' });
  showChannel(channel, replay);
}

function guideCard(channel, programme) {
  const now = Date.now() / 1000;
  const live = programme.start <= now && programme.stop > now;
  const canReplay = !live && programme.start < now && channel.archiveDays > 0;
  const action = live ? '● En direct' : canReplay ? '⟲ Revoir' : '';
  const card = el(
    'div',
    { className: `guide-card${live ? ' live' : ''}${action ? ' playable' : ''}`, title: programme.description || '' },
    el('span', { className: 'muted' }, `${formatHour(programme.start)} – ${formatHour(programme.stop)}`),
    el('strong', {}, programme.title),
    live && el('div', { className: 'bar' }, el('div', { style: `width:${((now - programme.start) / (programme.stop - programme.start)) * 100}%` })),
    action && el('small', { className: 'action' }, action),
    programme.description && el('p', { className: 'description', hidden: true }, programme.description),
  );
  card.onclick = () => {
    if (live) return watchChannel(channel);
    if (canReplay) return watchChannel(channel, programme);
    const description = card.querySelector('.description');
    if (description) description.hidden = !description.hidden;
  };
  return card;
}

async function renderGuide() {
  clearTimeout(guideTimer);
  document.querySelectorAll('#guide-times button').forEach((b) => b.classList.toggle('active', b.dataset.time === guideTime));
  const query = new URLSearchParams({ category: $('guide-category').value, at: GUIDE_TIMES[guideTime].at() });
  const channels = await getJson(`/api/guide?${query}`);

  $('guide-list').replaceChildren(
    ...channels.map((channel) =>
      el(
        'div',
        { className: 'guide-row' },
        el(
          'div',
          { className: 'guide-channel', title: 'Regarder en direct', onclick: () => watchChannel(channel) },
          channel.logo && el('img', { src: channel.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
          el('span', {}, channel.name),
        ),
        el('div', { className: 'guide-programmes' }, ...channel.programmes.map((p) => guideCard(channel, p))),
      ),
    ),
  );
  if (!channels.length) {
    $('guide-list').append(el('p', { className: 'muted' }, 'Pas de guide des programmes pour cette catégorie.'));
  }
  // "En ce moment" se met à jour tout seul chaque minute.
  if (guideTime === 'now') guideTimer = setTimeout(() => !$('guide').hidden && renderGuide(), 60000);
}

async function showGuide() {
  const select = $('guide-category');
  if (!select.options.length) {
    const categories = await getJson('/api/categories?type=live');
    select.append(...categories.map((c) => new Option(c.name, c.id)));
    const preferred = categories.find((c) => c.name === DEFAULT_LIVE_CATEGORY);
    if (preferred) select.value = preferred.id;
    select.onchange = renderGuide;
    $('guide-times').append(
      ...Object.entries(GUIDE_TIMES).map(([key, { label }]) => {
        const button = el('button', { className: 'secondary', textContent: label, onclick: () => ((guideTime = key), renderGuide()) });
        button.dataset.time = key;
        return button;
      }),
    );
  }
  await renderGuide();
}

// --- Navigation : onglets, catégories, liste ---------------------------------------

const handlers = { live: showChannel, vod: showMovie, series: showSeries };

async function loadList(append = false) {
  if (!append) offset = 0;
  const params = new URLSearchParams({ type: currentType, category: categorySelect.value, q: searchInput.value.trim(), offset });
  const items = await getJson(`/api/list?${params}`);
  offset += items.length;
  $('more').hidden = items.length < 200;

  const nodes = items.map((item) => {
    const li = el(
      'li',
      { className: currentType === 'live' ? '' : 'poster', title: item.name },
      item.logo && el('img', { src: item.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
      el('span', {}, item.name),
      item.archiveDays > 0 && el('small', { className: 'badge', title: `Replay ${item.archiveDays} jours` }, 'replay'),
    );
    li.dataset.id = item.id;
    li.onclick = () => {
      list.querySelector('.active')?.classList.remove('active');
      li.classList.add('active');
      handlers[currentType](item);
    };
    return li;
  });
  if (append) list.append(...nodes);
  else {
    list.replaceChildren(...nodes);
    list.scrollTop = 0;
  }
}

// `category` (optionnel) : catégorie à présélectionner.
async function selectType(type, category) {
  currentType = type;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));

  // Le programme occupe tout l'écran : on coupe la lecture en cours (une seule connexion).
  const isGuide = type === 'guide';
  $('guide').hidden = !isGuide;
  document.querySelector('aside').hidden = isGuide;
  document.querySelector('main').hidden = isGuide;
  if (isGuide) {
    stopPlayback();
    if (document.fullscreenElement) document.exitFullscreen();
    return showGuide();
  }

  searchInput.value = '';
  const categories = await getJson(`/api/categories?type=${type}`);
  categorySelect.replaceChildren(new Option('Toutes les catégories', ''), ...categories.map((c) => new Option(c.name, c.id)));
  const preferred = categories.find((c) => c.id === category) ||
    (type === 'live' ? categories.find((c) => c.name === DEFAULT_LIVE_CATEGORY) : categories[0]);
  if (preferred) categorySelect.value = preferred.id;
  await loadList();
}

// --- Démarrage et import -----------------------------------------------------------

function showSyncInfo(status) {
  const date = status.syncedAt &&
    new Date(status.syncedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  $('sync-info').textContent = date ? `${status.account?.username} @ ${status.account?.server} · catalogue du ${date}` : '';
  $('sync').hidden = $('logout').hidden = !status.syncedAt;
}

async function runImport(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = 'Import en cours…';
  try {
    const status = await getJson('/api/sync', { method: 'POST' });
    showSyncInfo(status);
    return status;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

async function startApp() {
  $('onboarding').hidden = true;
  $('app').hidden = false;
  document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => selectType(b.dataset.type)));
  let timer;
  searchInput.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadList(), 250);
  };
  categorySelect.onchange = () => loadList();
  $('more').onclick = () => loadList(true);
  await selectType('guide');
}

async function init() {
  const status = await getJson('/api/status');
  showSyncInfo(status);
  $('sync').onclick = async () => {
    try {
      await runImport($('sync'));
      await selectType(currentType);
    } catch (err) {
      setStatus(`Import impossible : ${err.message}`, true);
    }
  };

  $('logout').onclick = async () => {
    if (!confirm('Se déconnecter ? Le catalogue et le guide seront effacés, et les identifiants oubliés.')) return;
    stopPlayback();
    try {
      await getJson('/api/logout', { method: 'POST' });
      location.reload();
    } catch (err) {
      setStatus(`Déconnexion impossible : ${err.message}`, true);
    }
  };

  if (Object.keys(status.counts).length) return startApp();

  showOnboarding();
}

// --- Écran de connexion --------------------------------------------------------------

// Accès Xtream contenus dans une URL de playlist : lien http://serveur/get.php?username=…&password=…
// ou URL de flux http://serveur/[live/]utilisateur/motdepasse/123.ts
function credentialsFromUrl(text) {
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (username && password) return { server: url.origin, username, password };
  const parts = url.pathname.split('/').filter(Boolean);
  if (['live', 'movie', 'series', 'timeshift'].includes(parts[0])) parts.shift();
  if (parts.length >= 3) return { server: url.origin, username: decodeURIComponent(parts[0]), password: decodeURIComponent(parts[1]) };
  return null;
}

function showOnboarding() {
  const form = $('login');
  const message = (text, isError = false) => {
    $('onboarding-text').textContent = text;
    $('onboarding-text').classList.toggle('error', isError);
  };
  const fill = (credentials, source) => {
    if (!credentials) return message(`Aucun accès Xtream trouvé dans ${source}.`, true);
    for (const [name, value] of Object.entries(credentials)) form.elements[name].value = value;
    message(`Accès lus dans ${source} : vérifie-les puis connecte-toi.`);
  };
  $('onboarding').hidden = false;

  // Seul le début de la playlist est lu, dans le navigateur : la première URL de flux suffit.
  $('m3u-file').onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const lines = (await file.slice(0, 256 * 1024).text()).split(/\r?\n/);
    const credentials = lines.filter((l) => l.startsWith('http')).map(credentialsFromUrl).find(Boolean);
    fill(credentials, file.name);
    event.target.value = '';
  };
  $('m3u-link').oninput = (event) => event.target.value && fill(credentialsFromUrl(event.target.value), 'le lien');

  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $('import');
    button.disabled = true;
    button.textContent = 'Connexion…';
    try {
      await getJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      message('Connecté. Import du catalogue et du guide, ça prend quelques secondes…');
      await runImport(button);
      startApp();
    } catch (err) {
      message(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Se connecter et importer';
    }
  };
}

init().catch((err) => setStatus(`Serveur injoignable : ${err.message}`, true));
