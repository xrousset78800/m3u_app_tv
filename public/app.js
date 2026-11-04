const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const details = $('details');
const list = $('list');
const categorySelect = $('category');
const searchInput = $('search');
const seekBar = $('seek-bar');
const audioSelect = $('audio-track');

// Formats que ce lecteur décode : le serveur les copie tels quels, et réencode les autres en H.264.
const CODECS = Object.entries({
  hevc: 'hvc1.1.6.L120.90',
  hevc10: 'hvc1.2.4.L120.90',
  vp9: 'vp09.00.40.08',
  av1: 'av01.0.08M.08',
}).filter(([, codec]) => video.canPlayType(`video/mp4; codecs="${codec}"`)).map(([name]) => name).join();

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
  $('alert').textContent = isError ? text : '';
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

// Onglet d'où vient la lecture en cours : il garde un repère (▶ / ❚❚) quand on navigue ailleurs.
let playingTab = null;
let playingChannel = null; // chaîne en cours, repérée dans le programme
let selectedChannel = null; // chaîne dont la fiche est affichée

function paintPlayingChannel() {
  document.querySelectorAll('.guide-row').forEach((row) => {
    row.classList.toggle('playing', row.dataset.id === playingChannel);
    row.classList.toggle('selected', row.dataset.id === selectedChannel);
  });
}

function markPlayingTab(type) {
  playingTab = type;
  const icon = video.paused ? '❚❚' : '▶';
  document.querySelectorAll('#tabs button').forEach((b) => {
    if (b.dataset.type === type) b.dataset.playing = icon;
    else delete b.dataset.playing;
  });
}
video.addEventListener('play', () => markPlayingTab(playingTab));
video.addEventListener('pause', () => markPlayingTab(playingTab));

function stopPlayback() {
  markPlayingTab(null);
  playingChannel = null;
  paintPlayingChannel();
  if (hls) hls.destroy();
  hls = null;
  media = null;
  video.removeAttribute('src');
  video.load();
  video.classList.remove('media');
  $('seek').hidden = true;
  renderPlaylist();
}

// Le serveur répond 502 pour tout problème côté fournisseur : le vrai motif est dans sa réponse.
function hlsErrorText(data) {
  const xhr = data.networkDetails;
  const reply = ['', 'text'].includes(xhr?.responseType) ? xhr.responseText : '';
  const code = reply.match(/^Fournisseur : HTTP (\d+)/)?.[1] ?? (data.response?.code !== 502 && data.response?.code);
  return code
    ? `Le fournisseur refuse ce flux (HTTP ${code}) : chaîne indisponible, ou connexion déjà prise par un autre appareil.`
    : `Fournisseur injoignable (${data.details}).`;
}

const HLS_RETRIES = 3;

// Direct et replay : HLS via le proxy du serveur.
function playHls(src, label) {
  stopPlayback();
  markPlayingTab('live');
  playingChannel = src.match(/(\d+)\.m3u8/)?.[1] ?? null;
  paintPlayingChannel();
  setStatus(`Chargement de ${label}…`);
  if (window.Hls && Hls.isSupported()) {
    let retries = 0;
    const current = (hls = new Hls({ liveSyncDurationCount: 3 }));
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      retries = 0;
      setStatus(`▶ ${label}`);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      if (retries === HLS_RETRIES) return setStatus(hlsErrorText(data), true);
      // Souvent passager : la connexion unique de l'abonnement met quelques secondes à se libérer.
      retries++;
      setStatus(`Flux interrompu, nouvelle tentative (${retries}/${HLS_RETRIES})…`);
      setTimeout(() => hls === current && hls.loadSource(src), 2000 * retries);
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
  markPlayingTab(item.kind === 'movie' ? 'vod' : 'series'); // la playlist se lance depuis n'importe quel onglet
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
  renderPlaylist();
  startMediaAt(start);
}

let mediaLoad = 0;

async function startMediaAt(start) {
  const current = media;
  const load = ++mediaLoad;
  // Le serveur va couper le flux en cours : on le lâche d'abord, sinon il finirait en faux « ended ».
  video.removeAttribute('src');
  video.load();
  media.start = Math.max(0, Math.min(start, media.duration - 5));
  updateSeek();
  setStatus(`Chargement de ${media.title}…`);
  const query = new URLSearchParams({ kind: media.kind, id: media.id, ext: media.ext, codecs: CODECS });
  let point;
  try {
    point = await getJson(`/api/media/seek?${query}&start=${Math.floor(media.start)}`);
  } catch (err) {
    if (load === mediaLoad && current === media) setStatus(`Lecture impossible : ${err.message}`, true);
    return;
  }
  if (load !== mediaLoad || current !== media) return;
  // Le flux repart de ce point exact (souvent un peu avant) : la barre doit le suivre.
  media.start = point.start;
  query.set('start', point.start);
  query.set('audio', media.audio);
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
  if (!playNext()) media.onEnded?.();
});

video.addEventListener('error', () => {
  if (media) setStatus('Le flux s\'est interrompu.', true);
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

// --- Playlist (films et épisodes) -----------------------------------------------------

// Un élément y reste tant qu'il n'est pas terminé ou passé : on peut fermer l'appli et reprendre.
const playlist = (() => {
  try {
    return JSON.parse(localStorage.getItem('playlist')) || [];
  } catch {
    return [];
  }
})();

function savePlaylist() {
  try {
    localStorage.setItem('playlist', JSON.stringify(playlist));
  } catch {}
  renderPlaylist();
}

function removeFromPlaylist(key) {
  const index = playlist.findIndex((p) => p.key === key);
  if (index < 0) return;
  playlist.splice(index, 1);
  savePlaylist();
}

function togglePlaylist({ kind, id, ext, title, key }) {
  if (playlist.some((p) => p.key === key)) return removeFromPlaylist(key);
  playlist.push({ kind, id, ext, title, key });
  savePlaylist();
}

function nextInPlaylist() {
  const index = playlist.findIndex((p) => p.key === media?.key);
  return playlist[index + 1] || playlist.find((p) => p.key !== media?.key);
}

// Passe à l'élément suivant ; faux si la playlist n'a plus rien à lire.
function playNext() {
  const next = nextInPlaylist();
  if (media) removeFromPlaylist(media.key);
  if (next) playMedia(next, resumePosition(next));
  return Boolean(next);
}

const playlistLabel = (key) => (playlist.some((p) => p.key === key) ? '✓ Playlist' : '+ Playlist');

function playlistButton(item) {
  const button = el('button', { className: 'secondary', textContent: playlistLabel(item.key), onclick: () => togglePlaylist(item) });
  button.dataset.playlist = item.key;
  return button;
}

function renderPlaylist() {
  $('playlist').hidden = !playlist.length;
  $('playlist-title').textContent = `Playlist (${playlist.length})`;
  $('playlist-items').replaceChildren(
    ...playlist.map((item) =>
      el(
        'li',
        { className: item.key === media?.key ? 'playing' : '', title: item.title, onclick: () => playMedia(item, resumePosition(item)) },
        el('span', {}, item.title),
        el('button', {
          className: 'secondary',
          textContent: '✕',
          title: 'Retirer de la playlist',
          onclick: (e) => {
            e.stopPropagation();
            removeFromPlaylist(item.key);
          },
        }),
      ),
    ),
  );
  $('next').hidden = !media || !nextInPlaylist();
  document.querySelectorAll('[data-playlist]').forEach((b) => {
    b.textContent = playlistLabel(b.dataset.playlist);
  });
}

$('next').onclick = playNext;
renderPlaylist();

// Plein écran : toute la fenêtre passe en plein écran, la vidéo occupe la place que laisse la colonne.
const player = $('player');
const menu = $('tabs');
const aside = document.querySelector('aside');
let idleTimer;

// Dans l'appli, la fenêtre passe elle-même en plein écran : le moteur du navigateur peut refuser une
// demande faite depuis la page, pas celle-ci. Dans un navigateur (npm start), il n'y a que la page.
const appWindow = window.tvWindow;
let windowFullscreen = false;
let fullscreenSwitching = false; // navigateur : une bascule à la fois

function isFullscreen() {
  return appWindow ? windowFullscreen : Boolean(document.fullscreenElement);
}

function leaveFullscreen() {
  if (appWindow) appWindow.fullscreen('leave');
  else document.exitFullscreen();
}

function toggleFullscreen() {
  const leaving = isFullscreen();
  if (!leaving && player.closest('main').hidden) return;
  if (appWindow) {
    appWindow.fullscreen('toggle');
    return;
  }
  if (fullscreenSwitching) return;
  fullscreenSwitching = true;
  (leaving ? document.exitFullscreen() : document.documentElement.requestFullscreen())
    .catch((err) => setStatus(`Plein écran refusé : ${err.message}`, true))
    .finally(() => {
      fullscreenSwitching = false;
    });
}

function fullscreenChanged(on) {
  windowFullscreen = on;
  document.body.classList.toggle('cinema', on);
  wakeControls();
}

// Notre bouton plein écran, calé sur le bas de l'image et visible en même temps que les contrôles du lecteur.
const fullscreenButton = $('fullscreen-button');
fullscreenButton.addEventListener('click', toggleFullscreen);

function placeFullscreenButton() {
  const box = video.getBoundingClientRect();
  const home = player.getBoundingClientRect();
  fullscreenButton.style.right = `${home.right - box.right}px`;
  fullscreenButton.style.bottom = `${home.bottom - box.bottom}px`;
  fullscreenButton.classList.toggle('large', box.width > 1440);
}
const playerResized = new ResizeObserver(placeFullscreenButton);
[player, video, document.querySelector('.controls')].forEach((el) => playerResized.observe(el));

// Les colonnes n'ont qu'un état, qui ne change que par ☰ ou L : entrer en plein écran ou en sortir
// n'y touche pas, et il est conservé d'une fois sur l'autre.
let listClosed = (() => {
  try {
    return localStorage.getItem('listClosed') === '1';
  } catch {
    return false;
  }
})();

// Colonne fermée, le menu se réduit à ☰, posé sur la vidéo. Les réglages ont leur propre barre.
function placeMenu() {
  const closed = currentType !== 'settings' && listClosed;
  document.body.classList.toggle('list-closed', closed);
  const home = closed ? document.body : currentType === 'settings' ? document.querySelector('#settings .guide-bar') : aside;
  home.prepend(menu);
}

function toggleList() {
  if (currentType === 'settings') return;
  listClosed = !listClosed;
  try {
    localStorage.setItem('listClosed', listClosed ? '1' : '0');
  } catch {}
  placeMenu();
  wakeControls();
}

// Deuxième colonne : fermée à la demande, pour rendre sa place à la vidéo.
function closeFiche(closed) {
  document.body.classList.toggle('fiche-closed', closed);
  const toggle = $('fiche-toggle');
  toggle.setAttribute('aria-pressed', !closed);
  toggle.title = closed ? 'Afficher la fiche' : 'Masquer la fiche';
  try {
    localStorage.setItem('ficheClosed', closed ? '1' : '0');
  } catch {}
}
closeFiche((() => {
  try {
    return localStorage.getItem('ficheClosed') === '1';
  } catch {
    return false;
  }
})());
$('fiche-toggle').onclick = () => closeFiche(!document.body.classList.contains('fiche-closed'));

// En plein écran, le curseur, la barre de position et ☰ s'effacent après 3 s sans mouvement
// de souris. La colonne, elle, ne bouge pas.
function sleepControls() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}

function wakeControls(e) {
  document.body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (isFullscreen() && ![menu, aside].some((zone) => zone.contains(e?.target))) sleepControls();
}

// Sur l'image, les clics sont à nous : le lecteur ferait pause puis lecture à chaque double-clic.
// Sa barre de contrôles, en bas, garde les siens.
let videoClickTimer;
video.addEventListener('click', (e) => {
  const barHeight = video.classList.contains('media') ? 48 : 72; // films : pas de frise sous les boutons
  if (e.clientY > video.getBoundingClientRect().bottom - barHeight) return;
  e.preventDefault();
  clearTimeout(videoClickTimer);
  // Un clic n'agit qu'une fois sûr qu'aucun second ne suit.
  if (e.detail === 1) videoClickTimer = setTimeout(() => (video.paused ? video.play().catch(() => {}) : video.pause()), 250);
  if (e.detail === 2) toggleFullscreen();
});

let playerTimer;
function wakePlayer() {
  player.classList.add('awake');
  clearTimeout(playerTimer);
  playerTimer = setTimeout(sleepPlayer, 3000);
}
function sleepPlayer() {
  if (!video.paused) player.classList.remove('awake'); // en pause, le lecteur garde ses contrôles
}
player.addEventListener('mousemove', wakePlayer);
player.addEventListener('mouseleave', sleepPlayer);
video.addEventListener('pause', wakePlayer);
video.addEventListener('play', wakePlayer);

document.addEventListener('mousemove', wakeControls);
// Souris partie de la fenêtre (autre écran, autre application).
function mouseGone() {
  if (isFullscreen()) sleepControls();
}
document.documentElement.addEventListener('mouseleave', mouseGone);
window.addEventListener('blur', mouseGone);
document.addEventListener('fullscreenchange', () => {
  if (!appWindow) fullscreenChanged(Boolean(document.fullscreenElement));
});
if (appWindow) {
  appWindow.onFullscreen(fullscreenChanged);
  appWindow.isFullscreen().then(fullscreenChanged);
}
document.addEventListener('keydown', (e) => {
  // La fenêtre, elle, ne sort pas toute seule du plein écran avec Échap.
  if (e.key === 'Escape' && appWindow && isFullscreen()) return leaveFullscreen();
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const key = e.key.toLowerCase();
  if (key === 'f') toggleFullscreen();
  if (key === 'l') toggleList();
});

// --- TV : direct, guide des programmes et replay -----------------------------------

function playReplay(channel, programme) {
  const minutes = Math.ceil((programme.stop - programme.start) / 60);
  const query = new URLSearchParams({ start: programme.replayStart, minutes });
  playHls(`/replay/${channel.id}.m3u8?${query}`, `${channel.name} — ${programme.title} (replay)`);
}

function playLive(channel) {
  playHls(`/live/${channel.id}.m3u8`, channel.name);
}

// Affiche la fiche de la chaîne, sans rien lancer : le direct part de ▶ sur la ligne ou de « Direct » ici.
async function showChannel(channel) {
  selectedChannel = String(channel.id);
  paintPlayingChannel();

  const listEl = el('ul', { className: 'epg' });
  let replaying = null; // début du replay en cours, sur lequel se place la liste
  const head = el('div', { className: 'detail-head' },
    el('h2', {}, channel.name),
    el('button', {
      className: 'secondary',
      textContent: '● Direct',
      onclick: () => {
        replaying = null;
        listEl.querySelector('.playing')?.classList.remove('playing');
        playLive(channel);
      },
    }),
  );
  details.replaceChildren(head, el('p', { className: 'muted' }, 'Chargement du programme…'));

  let programs;
  try {
    programs = await getJson(`/api/epg/${channel.id}`);
  } catch {
    programs = [];
  }
  if (selectedChannel !== String(channel.id)) return; // une autre fiche a été demandée entre-temps
  if (!programs.length) {
    details.replaceChildren(head, el('p', { className: 'muted' }, 'Pas de guide des programmes pour cette chaîne.'));
    return;
  }

  const now = Date.now() / 1000;
  const dayKey = (ts) => new Date(ts * 1000).toDateString();
  const days = [...new Set(programs.map((p) => dayKey(p.start)))];
  const today = new Date().toDateString();
  const tabs = el('div', { className: 'days' });

  function renderDay(day) {
    tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.day === day));
    listEl.replaceChildren(
      ...programs.filter((p) => dayKey(p.start) === day).map((p) => {
        const current = p.start <= now && p.end > now;
        const canReplay = p.archive && p.start < now;
        const li = el(
          'li',
          { className: `${current ? 'current' : p.end < now ? 'past' : ''}${replaying >= p.start && replaying < p.end ? ' playing' : ''}`, title: p.title },
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
              textContent: current ? '⟲ Début' : '▶ Revoir',
              title: current ? 'Reprendre depuis le début' : 'Revoir ce programme',
              onclick: (e) => {
                e.stopPropagation();
                replaying = p.start;
                listEl.querySelector('.playing')?.classList.remove('playing');
                li.classList.add('playing');
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
    (listEl.querySelector('.playing') || listEl.querySelector('.current'))?.scrollIntoView({ block: 'center' });
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
  details.replaceChildren(head, tabs, listEl);
  renderDay(days.includes(today) ? today : days[days.length - 1]);
}

// --- Films -------------------------------------------------------------------------

// Position de reprise, 0 si l'élément est à peine commencé ou déjà terminé.
function resumePosition(item) {
  const saved = progress.get(item.key);
  return saved && saved.position > 30 && saved.position < saved.duration * 0.95 ? saved.position : 0;
}

function resumeButtons(item) {
  const resume = resumePosition(item);
  return [
    el('button', {
      textContent: resume ? `▶ Reprendre à ${formatTime(resume)}` : '▶ Lire',
      onclick: () => playMedia(item, resume),
    }),
    resume > 0 && el('button', { className: 'secondary', textContent: 'Depuis le début', onclick: () => playMedia(item, 0) }),
    playlistButton(item),
  ];
}

// Texte replié à quelques lignes pour ne pas repousser ce qui suit, avec un lien s'il dépasse.
// `extras` : éléments qui n'apparaissent qu'une fois déplié.
function foldable(text, extras = []) {
  const body = el('p', { className: 'fold' }, text);
  const link = el('button', { className: 'more', textContent: 'voir plus', hidden: true });
  const fit = () => {
    link.hidden = !body.classList.contains('open') && !extras.length && body.scrollHeight <= body.clientHeight;
  };
  link.onclick = () => {
    const open = body.classList.toggle('open');
    extras.forEach((extra) => (extra.hidden = !open));
    link.textContent = open ? 'voir moins' : 'voir plus';
    fit();
  };
  extras.forEach((extra) => (extra.hidden = true));
  new ResizeObserver(fit).observe(body); // mesurable seulement une fois affiché, et selon la largeur
  return [body, ...extras, link];
}

function infoBlock(info, buttons) {
  const meta = [info.year, info.genre, info.duration, info.rating && `★ ${info.rating}`].filter(Boolean).join(' · ');
  const credits = [
    info.director && el('p', { className: 'muted' }, `Réalisation : ${info.director}`),
    info.cast && el('p', { className: 'muted' }, `Avec : ${info.cast}`),
  ].filter(Boolean);
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
      ...(info.plot ? foldable(info.plot, credits) : credits),
    ),
  );
}

async function showMovie(movie) {
  selectedChannel = null;
  closeFiche(false); // rien ne se lance tout seul : la fiche (lecture) doit être visible
  details.replaceChildren(el('p', { className: 'muted' }, 'Chargement…'));
  const info = await getJson(`/api/vod/${movie.id}`).catch(() => ({ name: movie.name, cover: movie.logo }));
  const item = { kind: 'movie', id: movie.id, ext: info.ext || movie.ext, title: info.name || movie.name, key: `movie:${movie.id}` };
  details.replaceChildren(infoBlock(info, resumeButtons(item)));
}

// --- Séries ------------------------------------------------------------------------

async function showSeries(series) {
  selectedChannel = null;
  closeFiche(false);
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

  // Épisode à retrouver : celui en lecture, sinon le dernier commencé (ou sa suite s'il est fini).
  function resumeEpisode() {
    const playing = allEpisodes.find((e) => e.item.key === media?.key);
    if (playing) return playing;
    const last = allEpisodes.findLastIndex((e) => progress.get(e.item.key)?.position > 30);
    if (last < 0) return null;
    const saved = progress.get(allEpisodes[last].item.key);
    return saved.position >= saved.duration * 0.95 ? allEpisodes[last + 1] || allEpisodes[last] : allEpisodes[last];
  }
  const resume = resumeEpisode();

  function renderSeason(number) {
    episodesEl.replaceChildren(
      ...allEpisodes.filter((e) => e.season === number).map((e) => {
        const saved = progress.get(e.item.key);
        const watched = saved && saved.position >= saved.duration * 0.95;
        return el(
          'li',
          { className: `${watched ? 'watched' : ''}${e === resume ? ' playing' : ''}` },
          e.image && el('img', { src: e.image, loading: 'lazy', onerror: (ev) => ev.target.remove() }),
          el(
            'div',
            { className: 'program' },
            el('strong', {}, `${e.num}. ${e.title.replace(/^.* - S\d+E\d+ - /, '')}`),
            el('p', { className: 'muted' }, [e.duration, watched && 'vu'].filter(Boolean).join(' · ')),
            ...(e.plot ? foldable(e.plot) : []),
          ),
          el('div', { className: 'buttons' }, ...resumeButtons(e.item)),
        );
      }),
    );
  }

  seasonSelect.append(...info.seasons.map((s) => new Option(`Saison ${s.number} (${s.episodes.length} épisodes)`, s.number)));
  seasonSelect.onchange = () => renderSeason(Number(seasonSelect.value));
  details.replaceChildren(infoBlock(info, [seasonSelect]), episodesEl);
  if (info.seasons.length) {
    const season = resume ? resume.season : info.seasons[0].number;
    seasonSelect.value = season;
    renderSeason(season);
    episodesEl.querySelector('.playing')?.scrollIntoView({ block: 'center' });
  } else episodesEl.append(el('li', { className: 'muted' }, 'Aucun épisode disponible.'));
}

// --- TV : grille des chaînes, avec leurs programmes ----------------------------------

let guideTimer;
const FAVORITES = 'favorites'; // entrée « Favoris » de la liste des catégories
const PAGE = 200; // taille d'une page de résultats du serveur

// Chaînes favorites, propres à ce navigateur.
const favorites = (() => {
  try {
    return new Set(JSON.parse(localStorage.getItem('favorites')));
  } catch {
    return new Set();
  }
})();

function paintStar(star) {
  const on = favorites.has(star.dataset.favorite);
  star.textContent = on ? '★' : '☆';
  star.title = on ? 'Retirer des favoris' : 'Ajouter aux favoris';
  star.classList.toggle('on', on);
  star.setAttribute('aria-pressed', on);
}

function saveFavorites() {
  try {
    localStorage.setItem('favorites', JSON.stringify([...favorites]));
  } catch {}
}

function toggleFavorite(key) {
  if (!favorites.delete(key)) favorites.add(key);
  saveFavorites();
  document.querySelectorAll(`[data-favorite="${key}"]`).forEach(paintStar);
  if (!$('guide').hidden && $('guide-category').value === FAVORITES) renderGuide({ refresh: true });
}

function favoriteStar(id) {
  const star = el('button', {
    className: 'star',
    onclick: (e) => {
      e.stopPropagation();
      toggleFavorite(star.dataset.favorite);
    },
  });
  star.dataset.favorite = id;
  paintStar(star);
  return star;
}

// Les favoris se réordonnent en les faisant glisser.
let draggedFavorite = null;

function sortFavoritesIn(container) {
  container.addEventListener('dragstart', (e) => {
    draggedFavorite = e.target.closest('[draggable="true"]');
    if (!draggedFavorite) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', draggedFavorite.dataset.id);
    e.dataTransfer.setDragImage(draggedFavorite, 20, 20);
    draggedFavorite.classList.add('dragging');
  });
  container.addEventListener('dragover', (e) => {
    if (!draggedFavorite) return;
    e.preventDefault();
    const row = e.target.closest('[draggable="true"]');
    if (!row || row === draggedFavorite) return;
    const box = row.getBoundingClientRect();
    row.before(draggedFavorite);
    if (e.clientY > box.top + box.height / 2) row.after(draggedFavorite);
  });
  container.addEventListener('drop', (e) => e.preventDefault());
  container.addEventListener('dragend', () => {
    if (!draggedFavorite) return;
    draggedFavorite.classList.remove('dragging');
    draggedFavorite = null;
    // Ceux qui ne sont pas affichés (page suivante, chaîne retirée) gardent leur ordre, à la suite.
    const shown = [...container.querySelectorAll('[draggable="true"]')].map((row) => row.dataset.id);
    const others = [...favorites].filter((id) => !shown.includes(id));
    favorites.clear();
    [...shown, ...others].forEach((id) => favorites.add(id));
    saveFavorites();
    renderGuide({ refresh: true }); // la mise à jour de la minute a pu être sautée
  });
}
sortFavoritesIn($('guide-list'));

// Le programme de la ligne : une seule ligne de texte, le détail est dans l'infobulle et la fiche.
function guideProgramme(programme) {
  const now = Date.now() / 1000;
  const live = programme.start <= now && programme.stop > now;
  return el(
    'div',
    {
      className: `guide-programme${live ? ' live' : ''}`,
      title: [`${formatHour(programme.start)} – ${formatHour(programme.stop)} · ${programme.title}`, programme.description].filter(Boolean).join('\n'),
    },
    el('span', { className: 'muted' }, formatHour(programme.start)),
    el('strong', {}, programme.title),
    live && el('div', { className: 'bar' }, el('div', { style: `width:${((now - programme.start) / (programme.stop - programme.start)) * 100}%` })),
  );
}

let guideOffset = 0;
let guideLoad = 0;
let guideHasMore = false;
let guideAppending = false;

// La recherche porte sur toutes les chaînes, ou sur la catégorie choisie : pas sur les seuls favoris,
// où l'on ne retrouverait jamais une chaîne qu'on n'y a pas encore mise.
function guidePage(pageOffset) {
  const category = $('guide-category').value;
  const q = $('guide-search').value.trim();
  const query = new URLSearchParams({ at: Math.floor(Date.now() / 1000), q, offset: pageOffset });
  if (category === FAVORITES && !q) query.set('ids', [...favorites].join());
  else if (category !== FAVORITES) query.set('category', category);
  return getJson(`/api/guide?${query}`);
}

function guideRow(channel, sortable) {
  if (channel.separator) return el('div', { className: 'guide-separator' }, channel.name.replace(/^#+\s*|\s*#+$/g, ''));
  const [programme] = channel.programmes;
  const row = el(
    'div',
    {
      className: 'guide-row',
      title: `Voir le programme de ${channel.name}`,
      onclick: () => {
        closeFiche(false);
        showChannel(channel);
      },
    },
    el('button', {
      className: 'guide-play',
      textContent: '▶',
      title: `Regarder ${channel.name} en direct`,
      onclick: (e) => {
        e.stopPropagation();
        playLive(channel); // la fiche ne s'ouvre qu'au clic sur le reste de la ligne
      },
    }),
    el('div', { className: 'guide-logo' }, channel.logo && el('img', { src: channel.logo, loading: 'lazy', onerror: (e) => e.target.remove() })),
    el('span', { className: `guide-name${programme ? '' : ' wide'}` }, channel.name),
    programme && guideProgramme(programme),
    el('div', { className: 'guide-replay' }, channel.archiveDays > 0 && el('small', { className: 'badge', title: `Replay ${channel.archiveDays} jours` }, '⟲')),
    favoriteStar(channel.id),
  );
  row.dataset.id = channel.id;
  row.draggable = sortable;
  return row;
}

// `append` : page suivante. `refresh` : relit ce qui est déjà affiché, sans bouger la liste.
async function renderGuide({ append = false, refresh = false } = {}) {
  clearTimeout(guideTimer);
  const load = ++guideLoad;

  const channels = [];
  let page;
  do {
    page = await guidePage(append ? guideOffset : channels.length);
    if (load !== guideLoad) return; // une demande plus récente est partie entre-temps
    channels.push(...page);
  } while (refresh && page.length === PAGE && channels.length < guideOffset);

  const box = $('guide-list');
  const q = $('guide-search').value.trim();
  const showFavorites = $('guide-category').value === FAVORITES && !q;
  const nodes = channels.map((channel) => guideRow(channel, showFavorites));
  guideHasMore = page.length === PAGE;
  if (append) {
    guideOffset += channels.length;
    box.append(...nodes);
  } else {
    guideOffset = channels.length;
    const scroll = box.scrollTop;
    box.replaceChildren(...nodes);
    box.scrollTop = refresh ? scroll : 0;
  }
  paintPlayingChannel();
  if (!box.children.length) {
    box.append(
      el('p', { className: 'muted' }, showFavorites
        ? 'Aucun favori pour l\'instant : choisis une catégorie ci-dessus et clique sur l\'étoile ☆ des chaînes à garder ici.'
        : 'Aucune chaîne trouvée.'),
    );
  }
  // Ce qui passe se met à jour tout seul chaque minute.
  guideTimer = setTimeout(() => !$('guide').hidden && !draggedFavorite && renderGuide({ refresh: true }), 60000);
}

async function showGuide() {
  const select = $('guide-category');
  const first = !select.options.length;
  // Relue à chaque fois : des groupes ont pu être retirés dans les réglages.
  const categories = await getJson('/api/categories?type=live');
  const chosen = select.value;
  select.replaceChildren(new Option('Toutes les catégories', ''), new Option('★ Favoris', FAVORITES), ...categories.map((c) => new Option(c.name, c.id)));
  select.value = first ? (favorites.size ? FAVORITES : '') : chosen;
  if (select.selectedIndex < 0) select.value = ''; // catégorie disparue du catalogue
  $('guide-search').value = '';
  if (first) {
    select.onchange = () => renderGuide();
    let timer;
    $('guide-search').oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderGuide(), 250);
    };
    // La suite de la liste arrive d'elle-même, un peu avant d'atteindre le bas.
    $('guide-list').onscroll = ({ target: box }) => {
      if (!guideHasMore || guideAppending || box.scrollHeight - box.scrollTop - box.clientHeight > 600) return;
      guideAppending = true;
      renderGuide({ append: true })
        .catch((err) => setStatus(err.message, true))
        .finally(() => {
          guideAppending = false;
        });
    };
  }
  await renderGuide();
}

// --- Navigation : onglets, catégories, liste ---------------------------------------

const handlers = { vod: showMovie, series: showSeries };

async function loadList(append = false) {
  if (!append) offset = 0;
  const params = new URLSearchParams({ type: currentType, q: searchInput.value.trim(), offset, category: categorySelect.value });
  const items = await getJson(`/api/list?${params}`);
  offset += items.length;
  $('more').hidden = items.length < PAGE;

  const nodes = items.map((item) => {
    const li = el(
      'li',
      { className: 'poster', title: item.name },
      item.logo && el('img', { src: item.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
      el('span', {}, item.name),
    );
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

const chosenCategory = {}; // par onglet : la catégorie retrouvée en y revenant

async function selectType(type) {
  currentType = type;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));

  // La TV a sa grille, films et séries leur liste. Les réglages occupent tout l'écran :
  // le lecteur est masqué mais la lecture continue (l'onglet d'origine garde son repère ▶).
  const fullPage = type === 'settings';
  $('guide').hidden = type !== 'live';
  $('settings').hidden = !fullPage;
  $('browse').hidden = type === 'live';
  aside.hidden = fullPage;
  document.querySelector('main').hidden = fullPage;
  placeMenu();
  if (fullPage) {
    if (isFullscreen()) leaveFullscreen();
    return showSettings();
  }
  if (type === 'live') return showGuide();

  searchInput.value = '';
  const categories = await getJson(`/api/categories?type=${type}`);
  categorySelect.replaceChildren(
    new Option('Toutes les catégories', ''),
    ...categories.map((c) => new Option(c.name, c.id)),
  );
  categorySelect.value = chosenCategory[type] ?? '';
  if (categorySelect.selectedIndex < 0) categorySelect.value = ''; // catégorie disparue du catalogue
  chosenCategory[type] = categorySelect.value;
  await loadList();
  searchInput.focus();
}

// --- Réglages : chaînes et groupes -------------------------------------------------

const MANAGED_TYPES = { live: 'TV', vod: 'Films', series: 'Séries' };
let managedType = 'live';
let managedGroup = null; // groupe affiché à droite
let managedGroups = [];
let managedOffset = 0;

// Applique le choix, puis réaffiche : le groupe coché ou décoché change aussi la colonne de droite.
async function setHidden(kind, ids, hidden) {
  $('manage-note').classList.remove('error');
  try {
    await getJson('/api/hidden', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: managedType, kind, ids, hidden }),
    });
  } catch (err) {
    $('manage-note').textContent = `Modification impossible : ${err.message}`;
    $('manage-note').classList.add('error');
  }
  await renderManagedGroups();
  if (kind === 'category') await renderManagedItems();
}

// Dernière ligne cliquée, par liste : retrouvée par son id, car les listes sont réaffichées.
const managedAnchor = {};

// Applique l'état de la case à sa ligne, ou avec Maj à toute la plage depuis la ligne précédente.
function applyManaged(checkbox, kind, range) {
  const row = checkbox.closest('li');
  const rows = [...row.parentElement.children];
  const here = rows.indexOf(row);
  const anchor = rows.findIndex((li) => li.dataset.id === managedAnchor[kind]);
  const selected = range && anchor >= 0 ? rows.slice(Math.min(anchor, here), Math.max(anchor, here) + 1) : [row];
  const concerned = selected.filter((li) => !li.querySelector('input').disabled);
  for (const li of concerned) {
    li.querySelector('input').checked = checkbox.checked;
    li.classList.toggle('removed', !checkbox.checked);
  }
  managedAnchor[kind] = row.dataset.id;
  setHidden(kind, concerned.map((li) => li.dataset.id), !checkbox.checked);
}

// Clic sur la ligne plutôt que sur la case.
function flipManaged(row, kind, range) {
  const checkbox = row.querySelector('input');
  if (checkbox.disabled) return;
  checkbox.checked = !checkbox.checked;
  applyManaged(checkbox, kind, range);
}

function managedCheckbox(kind) {
  return el('input', {
    type: 'checkbox',
    onclick: (e) => {
      e.stopPropagation();
      applyManaged(e.target, kind, e.shiftKey);
    },
  });
}

function managedRow(item, kind, props, ...children) {
  const checkbox = managedCheckbox(kind);
  checkbox.checked = !item.hidden;
  const row = el('li', props, checkbox, ...children);
  row.dataset.id = item.id;
  return row;
}

const shownManagedGroups = () => {
  const filter = $('manage-group-search').value.trim().toLowerCase();
  return managedGroups.filter((g) => g.name.toLowerCase().includes(filter));
};

async function renderManagedGroups() {
  managedGroups = await getJson(`/api/manage/categories?type=${managedType}`);
  $('manage-groups').replaceChildren(
    ...shownManagedGroups().map((group) =>
      managedRow(
        group,
        'category',
        {
          className: `${group.id === managedGroup ? 'active' : ''}${group.hidden ? ' removed' : ''}`,
          title: group.name,
          onclick: (e) => {
            if (e.shiftKey) return flipManaged(e.currentTarget, 'category', true);
            managedGroup = group.id;
            $('manage-search').value = '';
            renderManagedGroups();
            renderManagedItems();
          },
        },
        el('span', {}, group.name),
        el('small', { className: 'muted' }, group.removed ? `${group.total - group.removed}/${group.total}` : group.total),
      ),
    ),
  );
}

async function renderManagedItems(append = false) {
  const q = $('manage-search').value.trim();
  const box = $('manage-items');
  if (!append) managedOffset = 0;
  $('manage-more').hidden = true;
  if (!q && managedGroup === null) {
    return box.replaceChildren(el('li', { className: 'muted' }, 'Clique sur un groupe pour voir son contenu, ou lance une recherche.'));
  }
  const params = new URLSearchParams({ type: managedType, offset: managedOffset });
  // La recherche couvre tout le catalogue : on cherche une chaîne sans savoir dans quel groupe elle est.
  if (q) params.set('q', q);
  else params.set('category', managedGroup);
  const items = await getJson(`/api/manage/items?${params}`);
  managedOffset += items.length;
  $('manage-more').hidden = items.length < 200;

  const nodes = items.map((item) => {
    const row = managedRow(
      item,
      'item',
      {
        className: item.hidden || item.groupHidden ? 'removed' : '',
        title: item.groupHidden ? 'Son groupe est décoché' : item.name,
        onclick: (e) => flipManaged(e.currentTarget, 'item', e.shiftKey),
      },
      item.logo && el('img', { src: item.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
      el('span', {}, item.name),
      q && el('small', { className: 'muted' }, managedGroups.find((g) => g.id === item.category)?.name ?? ''),
    );
    row.querySelector('input').disabled = Boolean(item.groupHidden);
    return row;
  });
  if (append) box.append(...nodes);
  else {
    box.replaceChildren(...nodes);
    box.scrollTop = 0;
    if (!nodes.length) box.append(el('li', { className: 'muted' }, 'Aucun résultat.'));
  }
}

function selectManagedType(type) {
  managedType = type;
  managedGroup = null;
  delete managedAnchor.category;
  delete managedAnchor.item;
  $('manage-search').value = '';
  $('manage-group-search').value = '';
  $('manage-types').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  return renderManagedGroups().then(() => renderManagedItems());
}

function showSettings() {
  if (!$('manage-types').children.length) {
    $('manage-types').append(
      ...Object.entries(MANAGED_TYPES).map(([type, label]) => {
        const button = el('button', { className: 'secondary', textContent: label, onclick: () => selectManagedType(type) });
        button.dataset.type = type;
        return button;
      }),
    );
    let timer;
    $('manage-search').oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(() => renderManagedItems(), 250);
    };
    $('manage-group-search').oninput = renderManagedGroups;
    $('manage-more').onclick = () => renderManagedItems(true);
    // Sur les groupes affichés : filtrer d'abord permet de n'en traiter qu'une partie.
    const setShownGroups = (hidden) => setHidden('category', shownManagedGroups().map((g) => g.id), hidden);
    $('manage-check').onclick = () => setShownGroups(false);
    $('manage-uncheck').onclick = () => setShownGroups(true);
  }
  return selectManagedType(managedType);
}

// --- Démarrage et import -----------------------------------------------------------

function showSyncInfo(status) {
  const format = (date) => new Date(date).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  $('sync-info').textContent = status.syncedAt
    ? [`${status.account?.username} @ ${status.account?.server}`, `catalogue du ${format(status.syncedAt)}`, status.epgSyncedAt && `guide du ${format(status.epgSyncedAt)}`].filter(Boolean).join(' · ')
    : '';
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
  document.querySelectorAll('#tabs button[data-type]').forEach((b) => (b.onclick = () => selectType(b.dataset.type)));
  $('list-toggle').onclick = toggleList;
  let timer;
  searchInput.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => loadList(), 250);
  };
  categorySelect.onchange = () => {
    chosenCategory[currentType] = categorySelect.value;
    searchInput.focus();
    loadList();
  };
  $('more').onclick = () => loadList(true);
  await selectType('live');
}

async function init() {
  const status = await getJson('/api/status');
  showSyncInfo(status);
  $('sync').onclick = async () => {
    try {
      await runImport($('sync'));
      await selectType(currentType);
    } catch (err) {
      $('sync-info').textContent = `Import impossible : ${err.message}`;
    }
  };

  $('logout').onclick = async () => {
    if (!confirm('Se déconnecter ? Le catalogue, le guide et les chaînes retirées seront effacés, et les identifiants oubliés.')) return;
    stopPlayback();
    try {
      await getJson('/api/logout', { method: 'POST' });
      playlist.length = 0;
      savePlaylist();
      location.reload();
    } catch (err) {
      $('sync-info').textContent = `Déconnexion impossible : ${err.message}`;
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

init()
  .then(() => {
    $('loading').hidden = true;
  })
  .catch((err) => {
    document.querySelector('#loading .spinner').hidden = true;
    $('loading-text').textContent = `Chargement impossible : ${err.message}. Relance l'appli.`;
  });
