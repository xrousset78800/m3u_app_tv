const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const details = $('details');
const panel = $('panel');
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
let panelHeld = false;

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

// Garde la colonne de droite ouverte sans survol, le temps que l'utilisateur y aille
// (fiche à lire, erreur à voir). Un clic ailleurs ou un passage de la souris dessus y met fin.
function holdPanel() {
  panelHeld = true;
  document.body.classList.add('reveal-right');
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  if (isError) holdPanel();
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

function paintPlayingChannel() {
  document.querySelectorAll('.guide-row').forEach((row) => row.classList.toggle('playing', row.dataset.id === playingChannel));
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
  markPlayingTab(currentType);
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

// Plein écran « cinéma » : toute la fenêtre passe en plein écran, la vidéo occupe l'écran,
// le menu flotte dessus tant que la souris bouge et la liste glisse par-dessus au bord gauche.
const player = $('player');
const menu = $('tabs');
const aside = document.querySelector('aside');
const EDGE = 60;
const EDGE_RIGHT = 16; // étroit : les boutons du lecteur sont juste à côté du bord droit
const EDGE_BOTTOM = 80;
let idleTimer;
let leavingFullscreen = false;

function toggleFullscreen() {
  if (document.fullscreenElement) {
    leavingFullscreen = true;
    document.exitFullscreen();
  } else if (!player.closest('main').hidden) {
    document.documentElement.requestFullscreen().catch((err) => setStatus(`Plein écran refusé : ${err.message}`, true));
  }
}

// Le bouton du lecteur met la vidéo seule en plein écran, sans menu ni barre de position :
// on passe aussitôt en « cinéma », et depuis celui-ci ce même bouton sert à sortir.
// Vrai si le changement en cours n'est qu'une étape vers un autre état.
function redirectFullscreen() {
  const current = document.fullscreenElement;
  if (current && (leavingFullscreen || (current === video && document.body.classList.contains('cinema')))) {
    leavingFullscreen = true;
    document.exitFullscreen();
    return true;
  }
  leavingFullscreen = false;
  if (current !== video) return false;
  document.documentElement.requestFullscreen().catch(() => {});
  return true;
}

// Le menu est en tête de la colonne de gauche (liste ou programme), ou de la barre des réglages ;
// en plein écran il flotte seul, la colonne étant repliée.
const MENU_HOMES = { guide: '#guide .guide-bar', settings: '#settings .guide-bar' };

// Colonne de gauche de l'onglet en cours (masquée dans les réglages).
const column = () => ($('guide').hidden ? aside : $('guide'));

// Liste repliée à la demande : comme en plein écran, le menu flotte et la liste glisse au bord gauche.
let listClosed = (() => {
  try {
    return localStorage.getItem('listClosed') === '1';
  } catch {
    return false;
  }
})();
let listHeld = false; // en plein écran : liste gardée ouverte avec ☰ ou L
let columnHeld = false; // colonne repliée mais ouverte le temps d'y aller, après le choix d'un onglet

function placeMenu() {
  const closed = listClosed && currentType !== 'settings' && !document.fullscreenElement;
  document.body.classList.toggle('list-closed', closed);
  const home = document.fullscreenElement || closed ? document.body : document.querySelector(MENU_HOMES[currentType] ?? 'aside');
  home.prepend(menu);
}

const menuFloats = () => document.fullscreenElement || document.body.classList.contains('list-closed');

function toggleList() {
  if (column().hidden) return; // les réglages n'ont pas de liste
  columnHeld = false;
  if (document.fullscreenElement) {
    listHeld = !listHeld;
    document.body.classList.toggle('reveal-left', listHeld);
  } else {
    listClosed = !listClosed;
    try {
      localStorage.setItem('listClosed', listClosed ? '1' : '0');
    } catch {}
    document.body.classList.remove('reveal-left');
    placeMenu();
  }
  wakeControls();
}

// Champ de la colonne en cours d'utilisation (recherche, catégorie) : elle reste affichée.
const editingColumn = () => column().contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);

// La colonne de droite se déplie au bord droit de l'écran, en plein écran ou non.
function updatePanel(e) {
  const over = panel.contains(e.target);
  if (over) panelHeld = false;
  document.body.classList.toggle('reveal-right', panelHeld || over || e.clientX >= window.innerWidth - EDGE_RIGHT);
}

// Contrôles et menu s'effacent après 3 s sans mouvement de souris,
// sauf si la souris est posée sur le menu, la liste ou la colonne de droite.
function wakeControls(e) {
  const body = document.body;
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  if (e) updatePanel(e);
  if (!menuFloats()) return;
  if (e) {
    // Ni le haut (menu) ni le bas (boutons du lecteur, juste à côté du bord gauche).
    const atEdge = e.clientX < EDGE && e.clientY > EDGE && e.clientY < window.innerHeight - EDGE_BOTTOM;
    const over = column().contains(e.target);
    if (over) columnHeld = false;
    body.classList.toggle('reveal-left', listHeld || columnHeld || atEdge || over || editingColumn());
  }
  if (![menu, column(), panel].some((zone) => zone.contains(e?.target))) {
    idleTimer = setTimeout(() => body.classList.add('idle'), 3000);
  }
}

video.addEventListener('dblclick', toggleFullscreen);
document.addEventListener('mousemove', wakeControls);
document.addEventListener('mousedown', (e) => {
  if (!panel.contains(e.target)) panelHeld = false;
  if (!column().contains(e.target) && !menu.contains(e.target)) columnHeld = false;
});
// Souris partie de la fenêtre (autre écran, autre application) : tout ce qu'elle dépliait se replie.
function mouseGone() {
  const body = document.body;
  panelHeld = false;
  columnHeld = false;
  body.classList.remove('reveal-right');
  body.classList.toggle('reveal-left', listHeld || editingColumn());
  if (menuFloats()) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => body.classList.add('idle'), 3000);
  }
}
document.documentElement.addEventListener('mouseleave', mouseGone);
window.addEventListener('blur', mouseGone);
document.addEventListener('fullscreenchange', () => {
  if (redirectFullscreen()) return;
  const on = Boolean(document.fullscreenElement);
  document.body.classList.toggle('cinema', on);
  if (!on) {
    listHeld = false;
    columnHeld = false;
    document.body.classList.remove('reveal-left');
  }
  placeMenu();
  wakeControls();
});
document.addEventListener('keydown', (e) => {
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
  let replaying = replay?.start; // début du replay en cours, sur lequel se place la liste

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
  details.replaceChildren(
    el('div', { className: 'detail-head' },
      el('h2', {}, channel.name),
      el('button', {
        className: 'secondary',
        textContent: '● Direct',
        onclick: () => {
          replaying = null;
          listEl.querySelector('.playing')?.classList.remove('playing');
          playHls(`/live/${channel.id}.m3u8`, channel.name);
        },
      }),
    ),
    tabs,
    listEl,
  );
  const replayDay = replay && dayKey(replay.start);
  renderDay(days.includes(replayDay) ? replayDay : days.includes(today) ? today : days[days.length - 1]);
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
const FAVORITES = 'favorites'; // entrée « Favoris » de la liste des catégories

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

function toggleFavorite(key) {
  if (!favorites.delete(key)) favorites.add(key);
  try {
    localStorage.setItem('favorites', JSON.stringify([...favorites]));
  } catch {}
  document.querySelectorAll(`[data-favorite="${key}"]`).forEach(paintStar);
  if (!$('guide').hidden && $('guide-category').value === FAVORITES) renderGuide();
  if (currentType === 'live' && categorySelect.value === FAVORITES) {
    list.querySelector(`li[data-id="${key}"]`)?.remove();
    if (!list.children.length) loadList();
  }
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

function guideCard(channel, programme) {
  const now = Date.now() / 1000;
  const live = programme.start <= now && programme.stop > now;
  const canReplay = !live && programme.start < now && channel.archiveDays > 0;
  const hint = live ? 'Regarder en direct' : canReplay ? 'Revoir' : '';
  const card = el(
    'div',
    {
      className: `guide-card${live ? ' live' : ''}${hint ? ' playable' : ''}`,
      // Sur une seule ligne, le titre est souvent coupé : le détail est dans l'infobulle.
      title: [`${formatHour(programme.start)} – ${formatHour(programme.stop)} · ${programme.title}`, hint, programme.description].filter(Boolean).join('\n'),
    },
    el('span', { className: 'muted' }, formatHour(programme.start)),
    el('strong', {}, programme.title),
    canReplay && el('small', { className: 'action' }, '⟲'),
    live && el('div', { className: 'bar' }, el('div', { style: `width:${((now - programme.start) / (programme.stop - programme.start)) * 100}%` })),
    programme.description && el('p', { className: 'description', hidden: true }, programme.description),
  );
  card.onclick = () => {
    if (live) return showChannel(channel);
    if (canReplay) return showChannel(channel, programme);
    const description = card.querySelector('.description');
    if (description) description.hidden = !description.hidden;
  };
  return card;
}

async function renderGuide() {
  clearTimeout(guideTimer);
  document.querySelectorAll('#guide-times button').forEach((b) => b.classList.toggle('active', b.dataset.time === guideTime));
  const category = $('guide-category').value;
  const showFavorites = category === FAVORITES;
  const query = new URLSearchParams({ at: GUIDE_TIMES[guideTime].at() });
  if (showFavorites) query.set('ids', [...favorites].join());
  else query.set('category', category);
  const channels = await getJson(`/api/guide?${query}`);

  $('guide-list').replaceChildren(
    ...channels.map((channel) => {
      const row = el(
        'div',
        { className: 'guide-row' },
        el(
          'div',
          { className: 'guide-channel', title: `Regarder ${channel.name} en direct`, onclick: () => showChannel(channel) },
          channel.logo && el('img', { src: channel.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
          el('span', {}, channel.name),
          favoriteStar(channel.id),
        ),
        channel.programmes.length
          ? el('div', { className: 'guide-programmes' }, ...channel.programmes.map((p) => guideCard(channel, p)))
          : el('p', { className: 'muted' }, 'Pas de guide des programmes pour cette chaîne.'),
      );
      row.dataset.id = channel.id;
      return row;
    }),
  );
  paintPlayingChannel();
  if (!channels.length) {
    $('guide-list').append(
      el('p', { className: 'muted' }, showFavorites
        ? 'Aucun favori pour l\'instant : choisis une catégorie ci-dessus et clique sur l\'étoile ☆ des chaînes à garder ici.'
        : 'Pas de guide des programmes pour cette catégorie.'),
    );
  }
  // "En ce moment" se met à jour tout seul chaque minute.
  if (guideTime === 'now') guideTimer = setTimeout(() => !$('guide').hidden && renderGuide(), 60000);
}

async function showGuide() {
  const select = $('guide-category');
  // Relue à chaque fois : des groupes ont pu être retirés dans les réglages.
  const categories = await getJson('/api/categories?type=live');
  const chosen = select.value;
  select.replaceChildren(new Option('★ Favoris', FAVORITES), ...categories.map((c) => new Option(c.name, c.id)));
  select.value = chosen;
  if (select.selectedIndex < 0) select.value = FAVORITES;
  if (!$('guide-times').children.length) {
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
  const showFavorites = categorySelect.value === FAVORITES;
  const params = new URLSearchParams({ type: currentType, q: searchInput.value.trim(), offset });
  if (showFavorites) params.set('ids', [...favorites].join());
  else params.set('category', categorySelect.value);
  const items = await getJson(`/api/list?${params}`);
  offset += items.length;
  $('more').hidden = items.length < 200;

  const nodes = items.map((item) => {
    if (item.separator) return el('li', { className: 'separator' }, item.name.replace(/^#+\s*|\s*#+$/g, ''));
    const li = el(
      'li',
      { className: currentType === 'live' ? '' : 'poster', title: item.name },
      item.logo && el('img', { src: item.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
      el('span', {}, item.name),
      item.archiveDays > 0 && el('small', { className: 'badge', title: `Replay ${item.archiveDays} jours` }, 'replay'),
      currentType === 'live' && favoriteStar(item.id),
    );
    li.dataset.id = item.id;
    li.onclick = () => {
      list.querySelector('.active')?.classList.remove('active');
      li.classList.add('active');
      // Film ou série : rien ne se lance tout seul, la fiche (lecture, épisodes) doit être visible.
      if (currentType !== 'live') holdPanel();
      handlers[currentType](item);
    };
    return li;
  });
  if (append) list.append(...nodes);
  else {
    list.replaceChildren(...nodes);
    list.scrollTop = 0;
    if (showFavorites && !nodes.length && !searchInput.value.trim()) {
      list.append(el('li', { className: 'muted' }, 'Aucun favori pour l\'instant : clique sur l\'étoile ☆ d\'une chaîne.'));
    }
  }
}

const chosenCategory = {}; // par onglet : la catégorie retrouvée en y revenant

async function selectType(type) {
  currentType = type;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));

  // Le programme remplace la liste, à côté du lecteur. Les réglages occupent tout l'écran :
  // le lecteur est masqué mais la lecture continue (l'onglet d'origine garde son repère ▶).
  const fullPage = type === 'settings';
  $('guide').hidden = type !== 'guide';
  $('settings').hidden = !fullPage;
  aside.hidden = type === 'guide' || fullPage;
  document.querySelector('main').hidden = fullPage;
  placeMenu();
  if (fullPage) {
    if (document.fullscreenElement) document.exitFullscreen();
    return showSettings();
  }
  if (menuFloats()) {
    columnHeld = true;
    document.body.classList.add('reveal-left');
  }
  if (type === 'guide') return showGuide();

  searchInput.value = '';
  const categories = await getJson(`/api/categories?type=${type}`);
  categorySelect.replaceChildren(
    new Option('Toutes les catégories', ''),
    ...(type === 'live' ? [new Option('★ Favoris', FAVORITES)] : []),
    ...categories.map((c) => new Option(c.name, c.id)),
  );
  categorySelect.value = chosenCategory[type] ?? '';
  if (categorySelect.selectedIndex < 0) categorySelect.value = ''; // catégorie disparue du catalogue
  chosenCategory[type] = categorySelect.value;
  await loadList();
  // Pas quand la liste est repliée : un champ actif la garderait ouverte.
  if (!menuFloats()) searchInput.focus();
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
