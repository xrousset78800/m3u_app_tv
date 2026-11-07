const $ = (id) => document.getElementById(id);
const video = $('video');
const statusEl = $('status');
const details = $('details');
const list = $('list');
const categorySelect = $('category');
const searchInput = $('search');
const seekBar = $('seek-bar');
const audioSelect = $('audio-track');
const subtitleSelect = $('subtitle-track');

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

// Données du navigateur propres à chaque compte (favoris, reprises, playlist, génériques…).
// Le premier compte, l'administrateur, garde les clés d'avant les comptes : rien n'est perdu.
// Le compte est retenu pour la session de la fenêtre ; en changer recharge la page.
const profileId = (() => {
  try {
    return sessionStorage.getItem('profile') || '1';
  } catch {
    return '1';
  }
})();
const scoped = (key, id = profileId) => (String(id) === '1' ? key : `p${id}:${key}`);
const storage = {
  getItem: (key) => localStorage.getItem(scoped(key)),
  setItem: (key, value) => localStorage.setItem(scoped(key), value),
  removeItem: (key) => localStorage.removeItem(scoped(key)),
};

// Les erreurs prévues du serveur arrivent aussi sous forme de clé, à traduire ici (en-tête X-Error).
async function getJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    let text = await res.text();
    try {
      const { key, vars } = JSON.parse(decodeURIComponent(res.headers.get('X-Error')));
      text = t(`error.${key}`, vars);
    } catch {}
    throw new Error(text);
  }
  return res.json();
}

// Message du statut, gardé sous forme de clé pour être retraduit si la langue change.
let statusMessage = null;

function setStatus(text, isError = false) {
  statusMessage = null;
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
  $('alert').textContent = isError ? text : '';
}

function say(key, vars, isError = false) {
  setStatus(t(key, vars), isError);
  statusMessage = { key, vars, isError };
}

// --- Langue de l'interface ------------------------------------------------------
// Textes dans public/i18n/<langue>.json ; le français sert de référence pour ce qui manquerait.
// La même langue sert aux fiches des films et séries, traduites par TMDB côté serveur.

const LANGUAGES = { 'fr-FR': 'Français', 'en-US': 'English', 'de-DE': 'Deutsch', 'es-ES': 'Español', 'it-IT': 'Italiano', 'pt-PT': 'Português' };
const DEFAULT_LANGUAGE = 'fr-FR';
const LANGUAGE_KEY = 'language';
let language = DEFAULT_LANGUAGE;
let strings = {};
let reference = {};

// Celle choisie, sinon au premier lancement celle du système si l'appli la connaît.
function initialLanguage() {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (LANGUAGES[saved]) return saved;
  } catch {}
  const codes = Object.keys(LANGUAGES);
  for (const wanted of navigator.languages || []) {
    const found = codes.find((code) => code === wanted) || codes.find((code) => code.split('-')[0] === wanted.split('-')[0]);
    if (found) return found;
  }
  return DEFAULT_LANGUAGE;
}

// t('player.retry', { count: 1, max: 3 }) ; un texte { one, other } est choisi selon `count`.
function t(key, vars = {}) {
  let text = strings[key] ?? reference[key] ?? key;
  if (typeof text === 'object') text = text[new Intl.PluralRules(language).select(vars.count)] ?? text.other;
  return text.replace(/\{(\w+)\}/g, (all, name) => (name in vars ? vars[name] : all));
}

const loadStrings = (code) => fetch(`i18n/${code}.json`).then((res) => (res.ok ? res.json() : {})).catch(() => ({}));

async function loadLanguage(code) {
  const [base, chosen] = await Promise.all([
    Object.keys(reference).length ? reference : loadStrings(DEFAULT_LANGUAGE),
    code === DEFAULT_LANGUAGE ? null : loadStrings(code),
  ]);
  reference = base;
  strings = chosen || base;
  language = code;
  document.documentElement.lang = code.split('-')[0];
  translatePage();
  paintLanguagePicker();
  paintView();
  window.tvWindow?.setLanguage?.(code); // pour les fenêtres de l'appli elle-même (mise à jour)
}

// Textes fixes de la page, repérés par leurs attributs data-i18n*.
function translatePage() {
  if (!Object.keys(reference).length) return; // fichiers illisibles : le français de la page reste
  document.querySelectorAll('[data-i18n]').forEach((node) => (node.textContent = t(node.dataset.i18n)));
  document.querySelectorAll('[data-i18n-html]').forEach((node) => (node.innerHTML = t(node.dataset.i18nHtml)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((node) => (node.placeholder = t(node.dataset.i18nPlaceholder)));
  document.querySelectorAll('[data-i18n-title]').forEach((node) => (node.title = t(node.dataset.i18nTitle)));
}

// Langue : choisie dans les réglages (Préférences), chacune avec son drapeau.
const flagUrl = (code) => `i18n/flags/${code}.svg`;

// Boutons à choix unique des Préférences.
function choiceButton(active, onclick, ...children) {
  const button = el('button', { type: 'button', className: active ? 'active' : '', onclick }, ...children);
  button.setAttribute('role', 'radio');
  button.setAttribute('aria-checked', active);
  return button;
}

function paintLanguagePicker() {
  $('language-choices').replaceChildren(
    ...Object.entries(LANGUAGES).map(([code, name]) =>
      choiceButton(code === language, () => chooseLanguage(code), el('img', { src: flagUrl(code), alt: '' }), el('span', {}, name)),
    ),
  );
}

// Présentation des listes, propre à chaque onglet (TV, Films, Séries) : compacte, normale, ou grandes
// vignettes (les affiches des films et séries en grille). L'icône de l'en-tête change celle de l'onglet
// affiché ; les Préférences les montrent toutes.
const VIEWS = {
  compact: '<path d="M2 3h12M2 6.3h12M2 9.7h12M2 13h12"/>',
  list: '<rect x="2" y="2.5" width="3.5" height="4" rx=".6"/><rect x="2" y="9.5" width="3.5" height="4" rx=".6"/><path d="M8 4.5h6M8 11.5h6"/>',
  large: '<rect x="2" y="2" width="5" height="5" rx=".8"/><rect x="9" y="2" width="5" height="5" rx=".8"/><rect x="2" y="9" width="5" height="5" rx=".8"/><rect x="9" y="9" width="5" height="5" rx=".8"/>',
};
const VIEW_TABS = ['live', 'vod', 'series'];
const views = (() => {
  const old = VIEWS[storage.getItem('view')] ? storage.getItem('view') : 'list'; // un seul choix avant 2.0.2
  let saved = {};
  try {
    saved = JSON.parse(storage.getItem('views')) || {};
  } catch {}
  return Object.fromEntries(VIEW_TABS.map((type) => [type, VIEWS[saved[type]] ? saved[type] : old]));
})();
const viewMenu = $('view-menu');

function viewIcon(mode) {
  const icon = el('span', { className: 'view-icon' });
  icon.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">${VIEWS[mode]}</svg>`;
  return icon;
}

function paintView() {
  const shown = VIEW_TABS.includes(currentType);
  const view = views[currentType];
  Object.keys(VIEWS).forEach((mode) => document.body.classList.toggle(`view-${mode}`, mode === view));
  $('view-picker').hidden = !shown; // rien à présenter sur la page des réglages
  if (shown) $('view-button').replaceChildren(viewIcon(view));
  viewMenu.replaceChildren(
    ...Object.keys(VIEWS).map((mode) => {
      const item = el('li', { role: 'option', className: mode === view ? 'active' : '', onclick: () => chooseView(currentType, mode) }, viewIcon(mode), el('span', {}, t(`view.${mode}`)));
      item.setAttribute('aria-selected', mode === view);
      return item;
    }),
  );
  $('view-choices').replaceChildren(
    ...VIEW_TABS.map((type) =>
      el(
        'div',
        { className: 'view-tab' },
        el('span', {}, t(`tabs.${type}`)),
        el('div', { className: 'choices' }, ...Object.keys(VIEWS).map((mode) =>
          choiceButton(mode === views[type], () => chooseView(type, mode), viewIcon(mode), el('span', {}, t(`view.${mode}`))),
        )),
      ),
    ),
  );
}

function chooseView(type, mode) {
  openViewMenu(false);
  views[type] = mode;
  storage.setItem('views', JSON.stringify(views));
  paintView();
}

// Placée par rapport au bouton, pour ne pas être coupée par la colonne.
function openViewMenu(open) {
  viewMenu.hidden = !open;
  $('view-button').setAttribute('aria-expanded', open);
  if (!open) return;
  const box = $('view-button').getBoundingClientRect();
  viewMenu.style.top = `${box.bottom + 4}px`;
  viewMenu.style.left = `${Math.max(8, box.right - viewMenu.offsetWidth)}px`;
}

$('view-button').onclick = (e) => {
  e.stopPropagation();
  openViewMenu(viewMenu.hidden);
};
document.addEventListener('click', (e) => {
  if (!$('view-picker').contains(e.target)) openViewMenu(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !viewMenu.hidden) openViewMenu(false);
});

async function chooseLanguage(code) {
  if (code === language) return;
  try {
    localStorage.setItem(LANGUAGE_KEY, code);
  } catch {}
  await loadLanguage(code);
  refreshTexts().catch((err) => setStatus(err.message, true));
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const formatHour = (ts) => new Date(ts * 1000).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });

// Position de lecture mémorisée (films et épisodes), propre à ce navigateur.
const progress = {
  get(key) {
    try {
      return JSON.parse(storage.getItem(`progress:${key}`)) || null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      storage.setItem(`progress:${key}`, JSON.stringify(value));
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
let rawLive = null; // nom de la chaîne lue en flux brut (voir playRaw)
let selectedChannel = null; // chaîne dont la fiche est affichée
let shownFiche = null; // réaffiche la fiche en cours (changement de langue)

function paintPlayingChannel() {
  document.querySelectorAll('.guide-row[data-id]').forEach((row) => {
    // Une autre version de la chaîne, retenue à sa place, compte aussi.
    row.classList.toggle('playing', Boolean(playingChannel) && (row.dataset.id === playingChannel || preferredId('live', row.dataset.id) === playingChannel));
    row.classList.toggle('selected', row.dataset.id === selectedChannel);
  });
}

// Film ou série en cours mis en évidence dans la liste, et l'épisode dans la fiche,
// même fiche repliée ou après être passé par un autre onglet.
function paintNowPlaying() {
  const type = media && (media.kind === 'movie' ? 'vod' : 'series');
  const id = media && String(media.kind === 'movie' ? media.id : media.series);
  const playing = (li) => li.dataset.id === id || (type === 'vod' && preferredId('vod', li.dataset.id) === id);
  list.querySelectorAll('li[data-id]').forEach((li) => li.classList.toggle('now-playing', currentType === type && playing(li)));
  document.querySelectorAll('.episodes li[data-key]').forEach((li) => li.classList.toggle('now-playing', li.dataset.key === media?.key));
}

function markPlayingTab(type) {
  playingTab = type;
  $('show-player').hidden = !type;
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
  liveChannel = null;
  rawLive = null;
  paintPlayingChannel();
  if (hls) hls.destroy();
  hls = null;
  media = null;
  paintNowPlaying();
  paintVersionsButton();
  stopSubtitles();
  unfreeze();
  video.removeAttribute('src');
  video.load();
  video.classList.remove('media', 'live');
  $('seek').hidden = true;
  showSkipButton();
  renderPlaylist();
}

// Sans lecteur (au lancement, ou fermé par ✕), la colonne prend sa place : la grille s'élargit
// et montre la suite et la soirée. La fiche garde la sienne, à droite.
function showPlayer(shown) {
  if (document.body.classList.contains('no-player') !== shown) return;
  document.body.classList.toggle('no-player', !shown);
  placeMenu();
  if (!$('guide').hidden) renderGuide({ refresh: true });
}

function closePlayer() {
  if (isFullscreen()) leaveFullscreen();
  cancelSleep();
  stopPlayback();
  say('player.idle');
  showPlayer(false);
}
$('close-player').addEventListener('click', closePlayer);

// Mise en veille : le lecteur se ferme au bout du temps choisi, ou à la fin du film ou de l'épisode.
// Elle survit aux changements de chaîne ; seul ✕ (ou « Désactivée ») l'annule.
const SLEEP_CHOICES = [15, 30, 45, 60, 90, 120];
const sleepButton = $('sleep-button');
const sleepMenu = $('sleep-menu');
let sleepAt = null; // heure d'arrêt (ms), ou 'end'
let sleepTimer;

function cancelSleep() {
  sleepAt = null;
  clearInterval(sleepTimer);
  paintSleep();
}

function setSleep(choice) {
  clearInterval(sleepTimer);
  sleepAt = choice === 'end' ? 'end' : choice ? Date.now() + choice * 60000 : null;
  if (typeof sleepAt === 'number') sleepTimer = setInterval(tickSleep, 5000);
  sleepMenu.hidden = true;
  paintSleep();
}

function tickSleep() {
  if (typeof sleepAt !== 'number') return;
  if (Date.now() >= sleepAt) return sleepNow();
  paintSleep();
}

function sleepNow() {
  closePlayer();
  say('sleep.done');
}

function paintSleep() {
  const minutes = typeof sleepAt === 'number' ? Math.max(1, Math.ceil((sleepAt - Date.now()) / 60000)) : null;
  sleepButton.classList.toggle('on', Boolean(sleepAt));
  sleepButton.querySelector('small').textContent = minutes ?? (sleepAt === 'end' ? '⏹' : '');
  sleepButton.title = minutes ? t('sleep.left', { count: minutes }) : sleepAt === 'end' ? t('sleep.end') : t('sleep.title');
}

function openSleepMenu() {
  const choice = (label, value, active) =>
    el('button', { className: active ? 'active' : '', textContent: label, onclick: (e) => { e.stopPropagation(); setSleep(value); } });
  sleepMenu.replaceChildren(
    choice(t('sleep.off'), null, !sleepAt),
    ...SLEEP_CHOICES.map((m) => choice(t('sleep.minutes', { count: m }), m, false)),
    ...(media ? [choice(t('sleep.end'), 'end', sleepAt === 'end')] : []),
    customSleep(),
  );
  sleepMenu.hidden = false;
}

// Durée libre, en minutes ; la dernière saisie est proposée la fois suivante.
function customSleep() {
  const input = el('input', { type: 'number', min: 1, max: 1440, step: 1, required: true, value: storage.getItem('sleep-custom') || '', placeholder: '75' });
  input.title = t('sleep.customTitle');
  return el(
    'form',
    {
      className: 'sleep-custom',
      onsubmit: (e) => {
        e.preventDefault();
        const minutes = Math.round(Number(input.value));
        if (!(minutes >= 1 && minutes <= 1440)) return;
        storage.setItem('sleep-custom', String(minutes));
        setSleep(minutes);
      },
    },
    el('span', {}, t('sleep.custom')),
    input,
    el('span', { className: 'muted' }, 'min'),
    el('button', { type: 'submit', className: 'secondary' }, 'OK'),
  );
}

sleepButton.addEventListener('click', (e) => {
  e.stopPropagation();
  if (sleepMenu.hidden) openSleepMenu();
  else sleepMenu.hidden = true;
});
document.addEventListener('click', (e) => {
  if (!sleepMenu.hidden && !sleepMenu.contains(e.target)) sleepMenu.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sleepMenu.hidden) sleepMenu.hidden = true;
});

// --- Versions : la même chaîne ou le même film dans une autre qualité ---------------
// Le choix est retenu : un clic sur n'importe quelle version lance ensuite la préférée,
// et les favoris passent à celle-ci.

let liveChannel = null; // chaîne en cours, en direct ou en replay : { id, name }
let shownMovie = null; // film dont la fiche est affichée
const versionsBox = $('versions');
const versionsPanel = $('versions-panel');
const versionsSearch = $('versions-search');
const versionsList = $('versions-list');
let versionsOf = null; // { type, id, same } : la version en cours et celles qui portent le même nom
let versionsLoad = 0;

function readPreferred() {
  try {
    return { live: {}, vod: {}, ...JSON.parse(storage.getItem('versions')) };
  } catch {
    return { live: {}, vod: {} };
  }
}
const preferred = readPreferred(); // par type : identifiant → version retenue

function savePreferred() {
  try {
    storage.setItem('versions', JSON.stringify(preferred));
  } catch {}
}

// Version retenue pour `id`, en suivant les choix successifs (A → B, puis B → C).
function preferredId(type, id) {
  let target = String(id);
  for (let hops = 0; hops < 5 && preferred[type][target]; hops++) target = preferred[type][target];
  return target === String(id) ? null : target;
}

// La version retenue, si elle est toujours là ; retirée du catalogue ou hors des groupes du compte, on l'oublie.
async function preferredItem(type, id) {
  const target = preferredId(type, id);
  if (!target) return null;
  const items = await getJson(`/api/list?${new URLSearchParams({ type, ids: target })}`).catch(() => null);
  if (items?.length) return items[0];
  if (items) {
    delete preferred[type][String(id)];
    savePreferred();
  }
  return null;
}

const versionsTarget = () =>
  media?.kind === 'movie' ? { type: 'vod', id: String(media.id) } : liveChannel && { type: 'live', id: liveChannel.id };

function paintVersionsButton() {
  versionsBox.hidden = !versionsTarget();
  if (versionsBox.hidden) versionsPanel.hidden = true;
}

// Sans `q` : recherche proposée d'après le nom en cours, qu'on peut ensuite modifier.
async function openVersions(q) {
  const target = versionsTarget();
  if (!target) return;
  const load = ++versionsLoad;
  versionsPanel.hidden = false;
  const params = new URLSearchParams(target);
  if (q === undefined) versionsList.replaceChildren(el('li', { className: 'muted' }, t('list.loading')));
  else params.set('q', q);
  let result;
  try {
    result = await getJson(`/api/versions?${params}`);
  } catch (err) {
    if (load === versionsLoad) versionsList.replaceChildren(el('li', { className: 'muted' }, err.message));
    return;
  }
  if (load !== versionsLoad) return;
  if (q === undefined) {
    versionsSearch.value = result.query;
    versionsOf = { ...target, same: result.items.filter((item) => item.same).map((item) => String(item.id)) };
  }
  const row = (item) => {
    const current = String(item.id) === target.id;
    return el(
      'li',
      {
        className: current ? 'current' : '',
        title: item.name,
        onclick: (e) => {
          e.stopPropagation();
          if (!current) chooseVersion(item);
        },
      },
      el('span', { className: 'name' }, item.name, current && el('small', { className: 'badge' }, t('versions.current'))),
      el('small', { className: 'muted' }, item.category || ''),
    );
  };
  const same = result.items.filter((item) => item.same);
  const others = result.items.filter((item) => !item.same);
  versionsList.replaceChildren(
    ...same.map(row),
    ...(others.length && same.length ? [el('li', { className: 'versions-heading' }, t('versions.others'))] : []),
    ...others.map(row),
  );
  if (!result.items.length) versionsList.append(el('li', { className: 'muted' }, t('versions.none')));
}

// La version choisie remplace la version en cours et ses homonymes : partout, et pour la suite.
function chooseVersion(item) {
  const target = versionsTarget();
  if (!target) return;
  const { type, id } = target;
  const chosen = String(item.id);
  const same = versionsOf?.type === type && versionsOf.id === id ? versionsOf.same : [];
  const replaced = [...new Set([id, ...same])].filter((other) => other !== chosen);
  replaced.forEach((other) => (preferred[type][other] = chosen));
  delete preferred[type][chosen];
  savePreferred();
  replaceFavorites(type, replaced, chosen);
  versionsPanel.hidden = true;
  if (type === 'live') return playLive(item, { exact: true });
  const start = Math.floor(position());
  playMedia({ kind: 'movie', id: chosen, ext: item.ext, title: item.name, key: `movie:${chosen}` }, start);
  if (replaced.includes(shownMovie)) showMovie(item, { exact: true });
}

$('versions-button').addEventListener('click', (e) => {
  e.stopPropagation();
  if (versionsPanel.hidden) openVersions();
  else versionsPanel.hidden = true;
});
versionsPanel.addEventListener('click', (e) => e.stopPropagation());
let versionsTimer;
versionsSearch.addEventListener('input', () => {
  clearTimeout(versionsTimer);
  versionsTimer = setTimeout(() => openVersions(versionsSearch.value.trim()), 250);
});
document.addEventListener('click', () => {
  versionsPanel.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !versionsPanel.hidden) versionsPanel.hidden = true;
});

// Masqué, le lecteur continue : on écoute en parcourant la grille large, et on y revient d'un clic.
$('hide-player').addEventListener('click', () => {
  if (isFullscreen()) leaveFullscreen();
  showPlayer(false);
});
$('show-player').addEventListener('click', () => showPlayer(true));

// Le serveur répond 502 pour tout problème côté fournisseur : le vrai motif est dans sa réponse.
function hlsErrorText(data) {
  const xhr = data.networkDetails;
  const reply = ['', 'text'].includes(xhr?.responseType) ? xhr.responseText : '';
  const code = reply.match(/^Fournisseur : HTTP (\d+)/)?.[1] ?? (data.response?.code !== 502 && data.response?.code);
  // Sinon le motif renvoyé par le serveur (erreur réseau vers le fournisseur) dit plus que le code de hls.js.
  return code ? ['player.refused', { code }] : ['player.unreachable', { details: reply.trim().slice(0, 120) || data.details }];
}

const HLS_RETRIES = 3;

// Direct et replay : HLS via le proxy du serveur.
// `fallback` : appelé si la playlist n'a jamais pu être chargée.
function playHls(src, label, fallback) {
  stopPlayback();
  showPlayer(true);
  markPlayingTab('live');
  playingChannel = src.match(/(\d+)\.m3u8/)?.[1] ?? null;
  paintPlayingChannel();
  say('player.loading', { label });
  if (window.Hls && Hls.isSupported()) {
    let retries = 0;
    let started = false;
    const current = (hls = new Hls({ liveSyncDurationCount: 3 }));
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      retries = 0;
      started = true;
      setStatus(`▶ ${label}`);
    });
    hls.on(Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) return hls.recoverMediaError();
      if (fallback && !started && /^manifest/.test(data.details)) return fallback();
      if (retries === HLS_RETRIES) return say(...hlsErrorText(data), true);
      // Souvent passager : la connexion unique de l'abonnement met quelques secondes à se libérer.
      retries++;
      say('player.retry', { count: retries, max: HLS_RETRIES });
      setTimeout(() => hls === current && hls.loadSource(src), 2000 * retries);
    });
    hls.loadSource(src);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = src;
  } else {
    say('player.noHls', {}, true);
  }
}

// Films et épisodes : MP4 produit par ffmpeg, relancé à chaque déplacement.
async function playMedia(item, start = 0) {
  stopPlayback();
  showPlayer(true);
  markPlayingTab(item.kind === 'series' ? 'series' : 'vod'); // la playlist se lance depuis n'importe quel onglet
  say('player.analysing', { title: item.title });
  // `series` : un compte restreint doit pouvoir montrer que l'épisode est d'une série autorisée.
  const query = new URLSearchParams({ kind: item.kind, id: item.id, ext: item.ext, series: item.series ?? '' });
  let info;
  try {
    info = await getJson(`/api/media/probe?${query}`);
  } catch (err) {
    return say('player.failed', { error: err.message }, true);
  }

  // Piste française par défaut si elle existe.
  const french = info.audio.findIndex((a) => /^fr/i.test(a.lang) || /\bVF|fran[cç]ais|french/i.test(a.title));
  media = { ...item, duration: info.duration || 0, audio: Math.max(0, french) };
  paintNowPlaying();
  paintVersionsButton();
  thumbs.clear();
  audioSelect.replaceChildren(
    ...info.audio.map((a, i) =>
      new Option([trackName(a), a.codec, a.channels].filter(Boolean).join(' · ') || t('player.track', { number: i + 1 }), i),
    ),
  );
  audioSelect.value = media.audio;
  audioSelect.hidden = info.audio.length < 2;
  media.subtitles = info.subtitles || [];
  media.fps = info.fps;
  const current = media;
  const saved = await getJson(`/api/subtitles/saved?${new URLSearchParams({ kind: item.kind, id: item.id })}`).catch(() => []);
  if (media !== current) return; // autre film lancé entre-temps
  media.online = saved;
  fillSubtitles();
  seekBar.max = Math.floor(media.duration);
  $('time-total').textContent = formatTime(media.duration);
  $('seek').hidden = false;
  video.classList.add('media');
  renderPlaylist();
  showSkipButton();
  // Reprise au milieu du générique de début : on part directement après.
  const skip = skipsFor(media);
  if (skip?.intro && start >= skip.introStart - 1 && start < skip.introEnd) {
    media.introSkipped = true;
    start = skip.introEnd;
  }
  startMediaAt(start);
}

let mediaLoad = 0;

// Pendant que le flux repart, la dernière image reste affichée à la place de l'écran noir du lecteur.
const frozen = $('frozen');
const frozenCanvas = frozen.querySelector('canvas');

function placeFrozen() {
  frozen.style.left = `${video.offsetLeft}px`;
  frozen.style.top = `${video.offsetTop}px`;
  frozen.style.width = `${video.offsetWidth}px`;
  frozen.style.height = `${video.offsetHeight}px`;
}

function freeze() {
  // Déplacements enchaînés : la vidéo est déjà vide, l'image figée reste la bonne.
  if (video.readyState < 2 || !video.videoWidth) return;
  frozenCanvas.width = video.videoWidth;
  frozenCanvas.height = video.videoHeight;
  frozenCanvas.getContext('2d').drawImage(video, 0, 0);
  placeFrozen();
  frozen.hidden = false;
}

function unfreeze() {
  frozen.hidden = true;
}

async function startMediaAt(start) {
  const current = media;
  const load = ++mediaLoad;
  freeze();
  stopSubtitles();
  // Le serveur va couper le flux en cours : on le lâche d'abord, sinon il finirait en faux « ended ».
  video.removeAttribute('src');
  video.load();
  media.start = Math.max(0, Math.min(start, media.duration - 5));
  updateSeek();
  say('player.loading', { label: media.title });
  const query = new URLSearchParams({ kind: media.kind, id: media.id, ext: media.ext, series: media.series ?? '', codecs: CODECS });
  let point;
  try {
    point = await getJson(`/api/media/seek?${query}&start=${Math.floor(media.start)}&audio=${media.audio}`);
  } catch (err) {
    if (load === mediaLoad && current === media) {
      unfreeze();
      say('player.failed', { error: err.message }, true);
    }
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
  followSubtitles();
}

// --- Sous-titres (pistes texte du fichier, extraites par le serveur pendant la lecture) ---

const subtitleTrack = video.addTextTrack('subtitles');
subtitleTrack.mode = 'disabled';
const SUBTITLE_KEY = 'subtitleLanguage'; // langue choisie la dernière fois, '' pour aucun
let subtitleFeed = null;
const delayBox = $('subtitle-delay');
// Décalage choisi à la main, retenu par film : certains fichiers ont des sous-titres pris d'une autre version.
let subtitleDelay = 0;
// Ligne d'affichage comptée depuis le bas : un peu au-dessus des commandes du lecteur.
const SUBTITLE_LINE = -3;

// Par film et par piste : une piste téléchargée bien calée n'a pas le décalage de celle du fichier.
function delayKey() {
  const track = subtitleSelect.value;
  return `subtitleDelay:${media.kind}:${media.id}${track.startsWith('os:') ? `:${track}` : ''}`;
}

// Vitesse : une piste prise d'une version européenne (25 images/s, film joué ~4 % plus vite) dérive
// peu à peu sur une vidéo à 23,976 ou 24 images/s. On étale ses horaires d'autant : rapport 25 / fps.
// Seulement dans ce sens : le texte arrive alors plus tard que le serveur ne le lit, jamais plus tôt.
const speedButton = delayBox.querySelector('.speed');
let subtitleSpeed = 1;
const speedKey = () => `subtitleSpeed:${media.kind}:${media.id}:${subtitleSelect.value}`;
const speedUsable = () => media?.fps > 23 && media.fps < 24.5;
// ffmpeg annonce « 23.98 » : la vraie valeur est 24000/1001, l'écart ferait ~1 s sur un film.
const videoFps = () => (Math.abs(media.fps - 23.976) < 0.01 ? 24000 / 1001 : media.fps);

function loadDelay() {
  subtitleDelay = 0;
  subtitleSpeed = 1;
  try {
    subtitleDelay = Number(storage.getItem(delayKey())) || 0;
    if (speedUsable() && storage.getItem(speedKey())) subtitleSpeed = 25 / videoFps();
  } catch {}
  showDelay();
}

function showDelay() {
  delayBox.hidden = subtitleSelect.hidden || subtitleSelect.value === '';
  const value = subtitleDelay.toLocaleString(language, { minimumFractionDigits: 1, signDisplay: 'exceptZero' });
  delayBox.querySelector('span').textContent = `${value} s`;
  speedButton.hidden = !speedUsable();
  if (speedUsable()) speedButton.textContent = `25 → ${(Math.round(videoFps() * 1000) / 1000).toLocaleString(language)}`;
  speedButton.classList.toggle('on', subtitleSpeed !== 1);
}

function toggleSpeed() {
  if (!media || delayBox.hidden || !speedUsable()) return;
  subtitleSpeed = subtitleSpeed === 1 ? 25 / videoFps() : 1;
  try {
    if (subtitleSpeed !== 1) storage.setItem(speedKey(), '1');
    else storage.removeItem(speedKey());
  } catch {}
  showDelay();
  followSubtitles(); // le serveur garde ce qu'il a déjà lu : tout revient, recalé
}

// Positif : le texte arrive plus tard. Plus tôt, la limite est ce que le serveur a déjà lu du film
// (quelques secondes d'avance) : un sous-titre reçu en retard s'affiche pour le temps qui lui reste.
function shiftSubtitles(step) {
  if (!media || delayBox.hidden) return;
  const next = Math.round(Math.max(-30, Math.min(30, subtitleDelay + step)) * 10) / 10;
  const diff = next - subtitleDelay;
  subtitleDelay = next;
  for (const cue of [...(subtitleTrack.cues || [])]) {
    cue.startTime = Math.max(0, cue.startTime + diff);
    cue.endTime += diff;
  }
  try {
    if (next) storage.setItem(delayKey(), next);
    else storage.removeItem(delayKey());
  } catch {}
  showDelay();
}

delayBox.addEventListener('click', (e) => {
  const step = Number(e.target.dataset.step);
  if (step) shiftSubtitles(step);
  if (e.target === speedButton) toggleSpeed();
});

// Codes de langue des fichiers (souvent « fre », « ger ») -> nom dans la langue de l'appli.
const BIBLIOGRAPHIC = { fre: 'fra', ger: 'deu', dut: 'nld', chi: 'zho', cze: 'ces', gre: 'ell', per: 'fas', rum: 'ron', slo: 'slk', alb: 'sqi', arm: 'hye', baq: 'eus', geo: 'kat', ice: 'isl', mac: 'mkd', may: 'msa', wel: 'cym' };

// « fre » (fichiers), « pt-br » (OpenSubtitles) -> nom dans la langue de l'appli.
function languageName(code) {
  if (!code || code === 'und') return '';
  try {
    const tag = (BIBLIOGRAPHIC[code] || code).replace(/-(\w+)$/, (all, region) => `-${region.toUpperCase()}`);
    return new Intl.DisplayNames([language], { type: 'language' }).of(tag);
  } catch {
    return code;
  }
}

// Nom d'une piste du fichier : la langue d'abord, le titre seul (« Complet », « SDH »…) ne la dit pas.
function trackName({ lang, title = '' }) {
  const language = languageName(lang);
  const named = language && language[0].toLocaleUpperCase() + language.slice(1);
  return [named, title.toLowerCase() !== language.toLowerCase() && title].filter(Boolean).join(' · ');
}

// Sous-titres téléchargés (OpenSubtitles), proposés si l'appli a une clé.
let onlineSubtitles = false;
const onlineCues = new Map(); // fileId -> sous-titres, déjà chargés

const choiceKey = () => `subtitleChoice:${media.kind}:${media.id}`;

function shortRelease(release) {
  return release.length > 40 ? `${release.slice(0, 38)}…` : release;
}

// Piste téléchargée choisie pour ce film, sinon même langue que la dernière fois si le fichier l'a
// (de préférence la piste complète, pas « forcés »).
function fillSubtitles() {
  const tracks = media.subtitles;
  const online = media.online || [];
  let saved = '';
  let choice = '';
  try {
    saved = storage.getItem(SUBTITLE_KEY) || '';
    choice = storage.getItem(choiceKey()) || '';
  } catch {}
  subtitleSelect.replaceChildren(
    new Option(t('player.subtitlesOff'), ''),
    ...tracks.map((s, i) => {
      const name = [trackName(s), s.forced && !/forc/i.test(s.title) && t('player.forced')].filter(Boolean).join(' · ');
      return new Option(name || t('player.track', { number: i + 1 }), i);
    }),
    ...online.map((s) => new Option(`🌐 ${[languageName(s.language), shortRelease(s.release)].filter(Boolean).join(' · ')}`, `os:${s.fileId}`)),
    ...(onlineSubtitles ? [new Option(t('player.subtitlesSearch'), 'search')] : []),
  );
  const pick = online.some((s) => `os:${s.fileId}` === choice)
    ? choice
    : saved && [...tracks.keys()].sort((a, b) => tracks[a].forced - tracks[b].forced).find((i) => tracks[i].lang === saved);
  subtitleSelect.value = pick ?? '';
  subtitleSelect.hidden = subtitleSelect.options.length < 2;
  loadDelay();
}

function stopSubtitles() {
  clearTimeout(subtitleFeed?.timer);
  subtitleFeed?.abort.abort(); // la demande en attente ne doit pas garder une connexion pour rien
  subtitleFeed = null;
  while (subtitleTrack.cues?.length) subtitleTrack.removeCue(subtitleTrack.cues[0]);
  subtitleTrack.mode = 'disabled';
}

// Les sous-titres arrivent au fur et à mesure que le serveur lit le film, à peine quelques secondes
// avant leur affichage : une demande reste en attente chez le serveur, qui répond dès qu'il y en a un nouveau.
// Horaires comptés depuis le début du film ; le lecteur, lui, compte depuis le point de départ.
function addCue(start, end, text) {
  const at = (time) => time * subtitleSpeed - media.start + subtitleDelay;
  if (at(end) <= 0) return;
  const cue = new VTTCue(Math.max(0, at(start)), at(end), text);
  cue.line = SUBTITLE_LINE;
  subtitleTrack.addCue(cue);
}

// Piste téléchargée : tout est déjà là, horaires comptés depuis le début du film.
async function showOnlineSubtitles(fileId) {
  const current = media;
  const feed = (subtitleFeed = { timer: null, abort: new AbortController() });
  let cues = onlineCues.get(fileId);
  if (!cues) {
    const query = new URLSearchParams({ kind: media.kind, id: media.id, file: fileId });
    cues = await getJson(`/api/subtitles/cues?${query}`, { signal: feed.abort.signal }).catch(() => null);
    if (cues) onlineCues.set(fileId, cues);
  }
  if (subtitleFeed !== feed || media !== current || !cues) return;
  for (const { start, end, text } of cues) addCue(start, end, text);
}

function followSubtitles() {
  stopSubtitles();
  if (!media || subtitleSelect.value === '' || subtitleSelect.value === 'search') return;
  subtitleTrack.mode = 'showing';
  if (subtitleSelect.value.startsWith('os:')) return showOnlineSubtitles(subtitleSelect.value.slice(3));
  const query = new URLSearchParams({ kind: media.kind, id: media.id, ext: media.ext, series: media.series ?? '', start: media.start, track: subtitleSelect.value });
  const feed = (subtitleFeed = { from: 0, timer: null, abort: new AbortController() });
  const poll = async () => {
    let reply = null;
    try {
      reply = await getJson(`/api/media/subtitles?${query}&from=${feed.from}`, { signal: feed.abort.signal });
    } catch {}
    if (subtitleFeed !== feed) return;
    for (const { start, end, text } of reply?.cues ?? []) addCue(start + media.start, end + media.start, text);
    feed.from += reply?.cues.length ?? 0;
    if (reply?.done) return;
    // Flux pas encore parti, ou erreur : on réessaie un peu plus tard ; sinon tout de suite.
    feed.timer = setTimeout(poll, reply?.ready ? 0 : 500);
  };
  poll();
}

let subtitleChosen = ''; // piste affichée avant d'ouvrir la recherche, rétablie si on n'y prend rien

subtitleSelect.addEventListener('focus', () => (subtitleChosen = subtitleSelect.value));
subtitleSelect.addEventListener('change', () => {
  if (!media) return;
  if (subtitleSelect.value === 'search') {
    subtitleSelect.value = subtitleChosen;
    return openSubtitleSearch();
  }
  subtitleChosen = subtitleSelect.value;
  const track = media.subtitles[subtitleSelect.value];
  try {
    // Piste du fichier : sa langue vaut pour les films suivants. Piste téléchargée : pour ce film seulement.
    if (subtitleSelect.value.startsWith('os:')) storage.setItem(choiceKey(), subtitleSelect.value);
    else {
      storage.removeItem(choiceKey());
      storage.setItem(SUBTITLE_KEY, track?.lang ?? '');
    }
  } catch {}
  loadDelay();
  followSubtitles();
});

// --- Recherche sur OpenSubtitles ---

const searchBox = $('subtitle-search');
const searchLanguage = searchBox.querySelector('.language');
const searchNote = searchBox.querySelector('.note');
const searchResults = searchBox.querySelector('.results');
const SEARCH_LANGUAGE_KEY = 'subtitleSearchLanguage';
const SEARCH_LANGUAGES = ['fr', 'en', 'de', 'es', 'it', 'pt-pt', 'pt-br', 'nl', 'pl', 'ro', 'ru', 'tr', 'ar', 'el', 'he', 'sv', 'da', 'no', 'fi', 'cs', 'hu', 'zh-cn', 'ja', 'ko'];
let searchTurn = 0;

function note(text, isError = false) {
  searchNote.textContent = text;
  searchNote.classList.toggle('error', isError);
}

function closeSubtitleSearch() {
  searchTurn++;
  searchBox.hidden = true;
}

function openSubtitleSearch() {
  let chosen = '';
  try {
    chosen = localStorage.getItem(SEARCH_LANGUAGE_KEY) || '';
  } catch {}
  const appLanguage = language === 'pt-PT' ? 'pt-pt' : language.slice(0, 2);
  searchLanguage.replaceChildren(
    ...SEARCH_LANGUAGES.map((code) => new Option(languageName(code), code)).sort((a, b) => a.text.localeCompare(b.text, language)),
  );
  searchLanguage.value = SEARCH_LANGUAGES.includes(chosen) ? chosen : appLanguage;
  searchBox.hidden = false;
  searchSubtitles();
}

async function searchSubtitles() {
  const turn = ++searchTurn;
  const current = media;
  searchResults.replaceChildren();
  note(t('subtitles.searching'));
  const query = new URLSearchParams({ kind: media.kind, id: media.id, tmdb: media.tmdb || '', title: media.title, languages: searchLanguage.value, fps: media.fps || '' });
  let results;
  try {
    results = await getJson(`/api/subtitles/search?${query}`);
  } catch (err) {
    if (turn === searchTurn) note(err.message, true);
    return;
  }
  if (turn !== searchTurn || current !== media) return;
  const saved = new Set((media.online || []).map((s) => s.fileId));
  note(results.length ? t('subtitles.quotaNote') : t('subtitles.none'));
  searchResults.replaceChildren(...results.map((s) => el('li', {}, subtitleResult(s, saved.has(s.fileId)))));
}

function subtitleResult(s, saved) {
  const tags = [
    saved && el('span', { className: 'good' }, t('subtitles.saved')),
    s.speed === 0 && el('span', { className: 'good' }, t('subtitles.sameSpeed')),
    s.speed === 2 && el('span', { className: 'warn' }, t('subtitles.otherSpeed', { fps: s.fps })),
    s.hearingImpaired && el('span', {}, t('subtitles.hearingImpaired')),
    s.foreignOnly && el('span', { className: 'warn' }, t('player.forced')),
    s.automatic && el('span', { className: 'warn' }, t('subtitles.automatic')),
    el('span', {}, t('subtitles.downloads', { count: s.downloads, number: s.downloads.toLocaleString(language) })),
  ];
  return el(
    'button',
    { type: 'button', onclick: () => downloadSubtitle(s) },
    el('span', { className: 'release' }, `${languageName(s.language)} · ${s.release}`),
    el('span', { className: 'tags' }, ...tags),
  );
}

async function downloadSubtitle(s) {
  const turn = ++searchTurn;
  const current = media;
  searchResults.querySelectorAll('button').forEach((b) => (b.disabled = true));
  note(t('subtitles.downloading'));
  let reply;
  try {
    reply = await getJson('/api/subtitles/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: media.kind, id: media.id, fileId: s.fileId, language: s.language, release: s.release }),
    });
  } catch (err) {
    if (turn !== searchTurn) return;
    searchResults.querySelectorAll('button').forEach((b) => (b.disabled = false));
    return note(err.message, true);
  }
  if (turn !== searchTurn || current !== media) return;
  const { cues, remaining, ...entry } = reply;
  onlineCues.set(entry.fileId, cues);
  media.online = [...(media.online || []).filter((o) => o.fileId !== entry.fileId), entry];
  try {
    localStorage.setItem(SEARCH_LANGUAGE_KEY, searchLanguage.value);
    storage.setItem(choiceKey(), `os:${entry.fileId}`);
  } catch {}
  closeSubtitleSearch();
  fillSubtitles();
  subtitleChosen = subtitleSelect.value;
  followSubtitles();
  if (remaining != null) say('subtitles.remaining', { count: remaining });
}

searchLanguage.addEventListener('change', searchSubtitles);
searchBox.querySelector('.close').addEventListener('click', closeSubtitleSearch);
searchBox.addEventListener('click', (e) => {
  if (e.target === searchBox) closeSubtitleSearch();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !searchBox.hidden) closeSubtitleSearch();
});

function position() {
  return media ? media.start + video.currentTime : 0;
}

function updateSeek() {
  if (!media || seeking) return;
  seekBar.value = Math.floor(position());
  $('time-current').textContent = formatTime(position());
}

video.addEventListener('playing', () => {
  unfreeze();
  if (media) setStatus(`▶ ${media.title}`);
  else if (rawLive) setStatus(`▶ ${rawLive}`);
});

// Aperçus de la barre. Le fournisseur n'autorise qu'une connexion, déjà prise par la lecture :
// on ne peut pas aller chercher une image ailleurs dans le film, seulement garder celles déjà vues.
const THUMB_EVERY = 10; // secondes
const THUMB_REACH = 3; // aperçus de distance acceptés au survol
const thumbs = new Map();
const thumbCanvas = document.createElement('canvas');

function captureThumb() {
  const slot = Math.floor(position() / THUMB_EVERY);
  if (thumbs.has(slot) || video.readyState < 2 || !video.videoWidth) return;
  thumbCanvas.width = 240;
  thumbCanvas.height = Math.round((240 * video.videoHeight) / video.videoWidth);
  thumbCanvas.getContext('2d').drawImage(video, 0, 0, thumbCanvas.width, thumbCanvas.height);
  thumbs.set(slot, thumbCanvas.toDataURL('image/jpeg', 0.6));
}

function nearestThumb(time) {
  const slot = Math.floor(time / THUMB_EVERY);
  for (let gap = 0; gap <= THUMB_REACH; gap++) {
    const found = thumbs.get(slot - gap) || thumbs.get(slot + gap);
    if (found) return found;
  }
  return null;
}

const seekPreview = $('seek-preview');
seekBar.addEventListener('mousemove', (e) => {
  if (!media?.duration) return;
  const bar = seekBar.getBoundingClientRect();
  const home = $('seek').getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - bar.left) / bar.width));
  const time = ratio * media.duration;
  const thumb = nearestThumb(time);
  const image = seekPreview.querySelector('img');
  if (thumb) image.src = thumb;
  else image.removeAttribute('src');
  seekPreview.querySelector('span').textContent = formatTime(time);
  seekPreview.hidden = false;
  const half = seekPreview.offsetWidth / 2;
  const x = e.clientX - home.left;
  seekPreview.style.left = `${Math.max(half, Math.min(home.width - half, x))}px`;
});
seekBar.addEventListener('mouseleave', () => {
  seekPreview.hidden = true;
});

video.addEventListener('timeupdate', () => {
  updateSeek();
  if (media) captureThumb();
  if (media && !seeking) skipCredits();
  if (!media || Date.now() - lastSave < 5000) return;
  lastSave = Date.now();
  progress.set(media.key, { position: position(), duration: media.duration });
});

// Fin d'un film ou d'un épisode : à la vraie fin, ou à l'entrée dans le générique de fin passé.
function finishMedia() {
  progress.set(media.key, { position: media.duration, duration: media.duration });
  if (sleepAt === 'end') return sleepNow(); // mise en veille « à la fin » : pas d'épisode suivant
  if (!playNext()) media.onEnded?.();
}

video.addEventListener('ended', () => {
  if (media) finishMedia();
});

video.addEventListener('error', () => {
  unfreeze();
  if (media || rawLive) say('player.interrupted', {}, true);
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

// --- Génériques des séries ------------------------------------------------------------
// Par série : début (de… à…, en secondes depuis le début) et fin (durée avant le bout de l'épisode),
// pour enchaîner les épisodes sans revoir les mêmes génériques.

const skips = (() => {
  try {
    return JSON.parse(storage.getItem('skips')) || {};
  } catch {
    return {};
  }
})();
const skipPanel = $('skip-panel');
const skipButton = $('skip-button');

const skipsFor = (item) => (item?.kind === 'series' && item.series ? skips[item.series] : null);

function saveSkips() {
  try {
    storage.setItem('skips', JSON.stringify(skips));
  } catch {}
}

// « 1:30 », « 1:02:03 » ou « 90 » ; vide ou illisible : null.
function parseTime(text) {
  const parts = text.trim().split(/[:h']/).filter(Boolean).map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts.reduce((total, n) => total * 60 + n, 0);
}

function showSkipButton() {
  const series = media?.kind === 'series' && Boolean(media.series);
  skipButton.hidden = !series;
  if (!series) skipPanel.hidden = true;
  const skip = skipsFor(media);
  skipButton.classList.toggle('on', Boolean(skip?.intro || skip?.outro));
  if (!skipPanel.hidden) fillSkipPanel();
}

function fillSkipPanel() {
  const skip = skipsFor(media) || {};
  $('skip-intro-on').checked = Boolean(skip.intro);
  $('skip-intro-start').value = skip.introStart != null ? formatTime(skip.introStart) : '';
  $('skip-intro-end').value = skip.introEnd != null ? formatTime(skip.introEnd) : '';
  $('skip-outro-on').checked = Boolean(skip.outro);
  $('skip-outro-length').value = skip.outroLength ? formatTime(skip.outroLength) : '';
}

// Relit le panneau ; un horaire saisi active sa ligne.
function readSkipPanel(changed) {
  if (!media?.series) return;
  const introStart = parseTime($('skip-intro-start').value) ?? 0;
  const introEnd = parseTime($('skip-intro-end').value);
  const outroLength = parseTime($('skip-outro-length').value);
  if (['skip-intro-start', 'skip-intro-end'].includes(changed) && introEnd != null) $('skip-intro-on').checked = true;
  if (changed === 'skip-outro-length' && outroLength) $('skip-outro-on').checked = true;
  skips[media.series] = {
    intro: $('skip-intro-on').checked && introEnd > introStart,
    introStart,
    introEnd,
    outro: $('skip-outro-on').checked && outroLength > 0,
    outroLength,
  };
  saveSkips();
  fillSkipPanel();
  showSkipButton();
}

skipButton.addEventListener('click', () => {
  skipPanel.hidden = !skipPanel.hidden;
  if (!skipPanel.hidden) fillSkipPanel();
});
skipPanel.addEventListener('change', (e) => readSkipPanel(e.target.id));
skipPanel.querySelectorAll('[data-now]').forEach((button) =>
  button.addEventListener('click', () => {
    // Fin : le temps qui reste d'ici le bout de l'épisode, valable pour les épisodes plus longs ou plus courts.
    const outro = button.dataset.now === 'skip-outro-length';
    $(button.dataset.now).value = formatTime(outro ? media.duration - position() : position());
    readSkipPanel(button.dataset.now);
  }),
);
document.addEventListener('click', (e) => {
  if (!skipPanel.hidden && !skipPanel.contains(e.target) && e.target !== skipButton) skipPanel.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !skipPanel.hidden) skipPanel.hidden = true;
});

// Pendant la lecture : saute le début une fois par épisode (on peut toujours y revenir à la main),
// et passe à la suite à l'entrée dans la fin. Panneau ouvert : on est en train de régler, rien ne saute.
function skipCredits() {
  const skip = skipsFor(media);
  if (!skip || !skipPanel.hidden) return;
  const at = position();
  if (skip.intro && !media.introSkipped && at >= skip.introStart && at < skip.introEnd - 1) {
    media.introSkipped = true;
    say('skip.introSkipped');
    startMediaAt(skip.introEnd);
    return;
  }
  if (skip.outro && !media.outroSkipped && media.duration && at >= media.duration - skip.outroLength && at < media.duration - 1) {
    media.outroSkipped = true;
    finishMedia();
  }
}

// --- Playlist (films et épisodes) -----------------------------------------------------

// Un élément y reste tant qu'il n'est pas terminé ou passé : on peut fermer l'appli et reprendre.
const playlist = (() => {
  try {
    return JSON.parse(storage.getItem('playlist')) || [];
  } catch {
    return [];
  }
})();

function savePlaylist() {
  try {
    storage.setItem('playlist', JSON.stringify(playlist));
  } catch {}
  renderPlaylist();
}

function removeFromPlaylist(key) {
  const index = playlist.findIndex((p) => p.key === key);
  if (index < 0) return;
  playlist.splice(index, 1);
  savePlaylist();
}

function togglePlaylist({ kind, id, ext, title, key, series }) {
  if (playlist.some((p) => p.key === key)) return removeFromPlaylist(key);
  playlist.push({ kind, id, ext, title, key, series });
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

const playlistLabel = (key) => t(playlist.some((p) => p.key === key) ? 'playlist.added' : 'playlist.add');

function playlistButton(item) {
  const button = el('button', { className: 'secondary', textContent: playlistLabel(item.key), onclick: () => togglePlaylist(item) });
  button.dataset.playlist = item.key;
  return button;
}

function renderPlaylist() {
  $('playlist').hidden = !playlist.length;
  $('playlist-title').textContent = t('playlist.title', { count: playlist.length });
  $('playlist-items').replaceChildren(
    ...playlist.map((item) =>
      el(
        'li',
        { className: item.key === media?.key ? 'playing' : '', title: item.title, onclick: () => playMedia(item, resumePosition(item)) },
        el('span', {}, item.title),
        el('button', {
          className: 'secondary',
          textContent: '✕',
          title: t('playlist.remove'),
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
    .catch((err) => say('player.fullscreenRefused', { error: err.message }, true))
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
const playerResized = new ResizeObserver(() => {
  placeFullscreenButton();
  placeFrozen();
});
[player, video, document.querySelector('.controls')].forEach((el) => playerResized.observe(el));

// Les colonnes n'ont qu'un état, qui ne change que par ☰ ou L : entrer en plein écran ou en sortir
// n'y touche pas, et il est conservé d'une fois sur l'autre.
let listClosed = (() => {
  try {
    return storage.getItem('listClosed') === '1';
  } catch {
    return false;
  }
})();

// Colonne fermée, le menu se réduit à ☰, posé sur la vidéo. Les réglages ont leur propre barre.
function placeMenu() {
  const closed = currentType !== 'settings' && listClosed && !document.body.classList.contains('no-player');
  document.body.classList.toggle('list-closed', closed);
  const home = closed ? document.body : currentType === 'settings' ? document.querySelector('#settings .guide-bar') : aside;
  home.prepend(menu);
}

function toggleList() {
  if (currentType === 'settings' || document.body.classList.contains('no-player')) return;
  listClosed = !listClosed;
  try {
    storage.setItem('listClosed', listClosed ? '1' : '0');
  } catch {}
  placeMenu();
  wakeControls();
}

// Deuxième colonne : ouverte au clic sur une ligne, elle rend sa place à la vidéo dès que la souris
// y retourne. Le court délai pardonne un passage involontaire.
let ficheTimer;

const ficheOpen = () => !document.body.classList.contains('fiche-closed') && details.childElementCount > 0;

function closeFiche(closed) {
  clearTimeout(ficheTimer);
  document.body.classList.toggle('fiche-closed', closed);
}
player.addEventListener('mouseenter', () => {
  ficheTimer = setTimeout(() => closeFiche(true), 300);
});
[aside, details].forEach((zone) => zone.addEventListener('mouseenter', () => clearTimeout(ficheTimer)));

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
  // Comme VLC : G avance les sous-titres, H les retarde.
  if (key === 'g') shiftSubtitles(-0.5);
  if (key === 'h') shiftSubtitles(0.5);
  if (key === 'j') toggleSpeed();
});

// --- TV : direct, guide des programmes et replay -----------------------------------

function playReplay(channel, programme) {
  const minutes = Math.ceil((programme.stop - programme.start) / 60);
  const query = new URLSearchParams({ start: programme.replayStart, minutes });
  playHls(`/replay/${channel.id}.m3u8?${query}`, `${channel.name} — ${programme.title} (replay)`);
  liveChannel = { id: String(channel.id), name: channel.name };
  paintVersionsButton();
}

// Chaînes dont le fournisseur refuse la playlist HLS (souvent la 4K, qui part sur un autre serveur
// de diffusion) : leur flux brut passe par ffmpeg, comme les films. Retenu jusqu'à la fermeture.
const rawChannels = new Set();

function playRaw(channel) {
  stopPlayback();
  showPlayer(true);
  markPlayingTab('live');
  playingChannel = String(channel.id);
  rawLive = channel.name;
  paintPlayingChannel();
  say('player.loading', { label: channel.name });
  video.src = `/media/live/${channel.id}?${new URLSearchParams({ codecs: CODECS })}`;
  video.play().catch(() => {});
}

// La version retenue de la chaîne (⇄ du lecteur), si elle en a une ; `exact` : celle-ci, telle quelle.
async function playLive(channel, { exact = false } = {}) {
  const chosen = !exact && (await preferredItem('live', channel.id));
  if (chosen) channel = chosen;
  const id = String(channel.id);
  const remember = () => {
    video.classList.add('live'); // pas de retour en arrière possible : barre native masquée
    liveChannel = { id, name: channel.name };
    paintVersionsButton();
  };
  if (rawChannels.has(id)) playRaw(channel);
  else {
    playHls(`/live/${id}.m3u8`, channel.name, () => {
      console.warn(`HLS refusé pour ${channel.name} : flux brut`);
      rawChannels.add(id);
      playRaw(channel);
      remember();
    });
  }
  remember();
}

// Affiche la fiche de la chaîne, sans rien lancer : le direct part de ▶ sur la ligne ou de « Direct » ici.
async function showChannel(channel) {
  selectedChannel = String(channel.id);
  shownMovie = null;
  shownFiche = () => showChannel(channel);
  paintPlayingChannel();

  const listEl = el('ul', { className: 'epg' });
  let replaying = null; // début du replay en cours, sur lequel se place la liste
  const head = el('div', { className: 'detail-head' },
    el('h2', {}, channel.name),
    el('button', {
      className: 'secondary',
      textContent: t('channel.live'),
      onclick: () => {
        replaying = null;
        listEl.querySelector('.playing')?.classList.remove('playing');
        playLive(channel);
      },
    }),
  );
  details.replaceChildren(head, el('p', { className: 'muted' }, t('channel.loading')));

  let programs;
  try {
    programs = await getJson(`/api/epg/${channel.id}`);
  } catch {
    programs = [];
  }
  if (selectedChannel !== String(channel.id)) return; // une autre fiche a été demandée entre-temps
  if (!programs.length) {
    details.replaceChildren(head, el('p', { className: 'muted' }, t('channel.noGuide')));
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
              textContent: t(current ? 'channel.restart' : 'channel.replay'),
              title: t(current ? 'channel.restartTitle' : 'channel.replayTitle'),
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
        textContent: day === today ? t('channel.today') : new Date(day).toLocaleDateString(language, { weekday: 'short', day: 'numeric' }),
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
      textContent: resume ? t('media.resume', { time: formatTime(resume) }) : t('media.play'),
      onclick: () => playMedia(item, resume),
    }),
    resume > 0 && el('button', { className: 'secondary', textContent: t('media.fromStart'), onclick: () => playMedia(item, 0) }),
    playlistButton(item),
  ];
}

// Texte replié à quelques lignes pour ne pas repousser ce qui suit, avec un lien s'il dépasse.
// `extras` : éléments qui n'apparaissent qu'une fois déplié.
function foldable(text, extras = []) {
  const body = el('p', { className: 'fold' }, text);
  const link = el('button', { className: 'more', textContent: t('media.foldMore'), hidden: true });
  const fit = () => {
    link.hidden = !body.classList.contains('open') && !extras.length && body.scrollHeight <= body.clientHeight;
  };
  link.onclick = () => {
    const open = body.classList.toggle('open');
    extras.forEach((extra) => (extra.hidden = !open));
    link.textContent = t(open ? 'media.foldLess' : 'media.foldMore');
    fit();
  };
  extras.forEach((extra) => (extra.hidden = true));
  new ResizeObserver(fit).observe(body); // mesurable seulement une fois affiché, et selon la largeur
  return [body, ...extras, link];
}

function infoBlock(info, buttons, star) {
  const meta = [info.year, info.genre, info.duration, info.rating && `★ ${info.rating}`].filter(Boolean).join(' · ');
  const credits = [
    info.director && el('p', { className: 'muted' }, t('media.director', { names: info.director })),
    info.cast && el('p', { className: 'muted' }, t('media.cast', { names: info.cast })),
  ].filter(Boolean);
  return el(
    'div',
    { className: 'info' },
    info.cover && el('img', { src: info.cover, className: 'cover', onerror: (e) => e.target.remove() }),
    el(
      'div',
      {},
      el('div', { className: 'detail-head' }, el('h2', {}, info.name), star),
      meta && el('p', { className: 'muted' }, meta),
      el('div', { className: 'buttons' }, ...buttons),
      ...(info.plot ? foldable(info.plot, credits) : credits),
    ),
  );
}

// La fiche de la version retenue (⇄ du lecteur), si le film en a une ; `exact` : celle-ci, telle quelle.
async function showMovie(movie, { exact = false } = {}) {
  selectedChannel = null;
  shownFiche = () => showMovie(movie, { exact });
  closeFiche(false); // rien ne se lance tout seul : la fiche (lecture) doit être visible
  details.replaceChildren(el('p', { className: 'muted' }, t('list.loading')));
  const chosen = !exact && (await preferredItem('vod', movie.id));
  if (chosen) movie = chosen;
  shownMovie = String(movie.id);
  const info = await getJson(`/api/vod/${movie.id}?${languageParam()}`).catch(() => ({ name: movie.name, cover: movie.logo }));
  const item = { kind: 'movie', id: movie.id, ext: info.ext || movie.ext, tmdb: info.tmdbId, title: info.name || movie.name, key: `movie:${movie.id}` };
  details.replaceChildren(infoBlock(info, resumeButtons(item), favoriteStar('vod', movie.id)));
}

// --- Séries ------------------------------------------------------------------------

async function showSeries(series) {
  selectedChannel = null;
  shownMovie = null;
  shownFiche = () => showSeries(series);
  closeFiche(false);
  details.replaceChildren(el('p', { className: 'muted' }, t('list.loading')));
  const info = await getJson(`/api/series/${series.id}?${languageParam()}`);
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
        tmdb: e.tmdbId,
        title: `${info.name} — S${String(s.number).padStart(2, '0')}E${String(e.num).padStart(2, '0')}`,
        key: `episode:${e.id}`,
        series: String(series.id),
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
        const li = el(
          'li',
          { className: `${watched ? 'watched' : ''}${e === resume ? ' playing' : ''}${e.item.key === media?.key ? ' now-playing' : ''}` },
          e.image && el('img', { src: e.image, loading: 'lazy', onerror: (ev) => ev.target.remove() }),
          el(
            'div',
            { className: 'program' },
            el('strong', {}, `${e.num}. ${e.title.replace(/^.* - S\d+E\d+ - /, '')}`),
            el('p', { className: 'muted' }, [e.duration, watched && t('series.watched')].filter(Boolean).join(' · ')),
            ...(e.plot ? foldable(e.plot) : []),
          ),
          el('div', { className: 'buttons' }, ...resumeButtons(e.item)),
        );
        li.dataset.key = e.item.key;
        return li;
      }),
    );
  }

  seasonSelect.append(...info.seasons.map((s) => new Option(t('series.season', { number: s.number, count: s.episodes.length }), s.number)));
  seasonSelect.onchange = () => renderSeason(Number(seasonSelect.value));
  details.replaceChildren(infoBlock(info, [seasonSelect], favoriteStar('series', series.id)), episodesEl);
  if (info.seasons.length) {
    const season = resume ? resume.season : info.seasons[0].number;
    seasonSelect.value = season;
    renderSeason(season);
    episodesEl.querySelector('.playing')?.scrollIntoView({ block: 'center' });
  } else episodesEl.append(el('li', { className: 'muted' }, t('series.noEpisode')));
}

// --- TV : grille des chaînes, avec leurs programmes ----------------------------------

let guideTimer;
const PAGE = 200; // taille d'une page de résultats du serveur

// Favoris propres au compte, par onglet : chaînes, films, séries (la série entière).
// Chaque onglet en a une ou plusieurs pages, nommées ; l'étoile ajoute à la page choisie en dernier.
// La première garde son ancien emplacement de stockage, les autres et les noms sont à côté.
const FAVORITE_STORES = { live: 'favorites', vod: 'favorites-vod', series: 'favorites-series' };
const NEW_PAGE = 'fav:new'; // entrée « Nouvelle page de favoris » de la liste des catégories
const pageValue = (index) => `fav:${index}`;
const favoritePageOf = (value) => (/^fav:\d+$/.test(value) ? Number(value.slice(4)) : -1);

function readJson(key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}
const idSet = (ids) => new Set(Array.isArray(ids) ? ids.map(String) : []);

const favoritePages = Object.fromEntries(
  Object.entries(FAVORITE_STORES).map(([type, store]) => {
    const saved = readJson(`${store}-pages`);
    const pages = Array.isArray(saved) ? saved : [];
    return [type, [
      { name: String(pages[0]?.name || ''), ids: idSet(readJson(store)) },
      ...pages.slice(1).map((page) => ({ name: String(page?.name || ''), ids: idSet(page?.ids) })),
    ]];
  }),
);
const activePage = Object.fromEntries(
  Object.entries(FAVORITE_STORES).map(([type, store]) => [type, Math.min(Number(storage.getItem(`${store}-page`)) || 0, favoritePages[type].length - 1)]),
);
const favoriteSet = (type) => favoritePages[type][activePage[type]].ids;
const pageName = (type, index) => favoritePages[type][index].name || t('favorites.defaultName');
const pageLabel = (type, index) => (favoritePages[type][index].name ? `★ ${favoritePages[type][index].name}` : t('list.favorites'));
// Au premier affichage : la page de favoris en cours, s'il y a des favoris.
const defaultCategory = (type) => (favoritePages[type].some((page) => page.ids.size) ? pageValue(activePage[type]) : '');

function paintStar(star) {
  const type = star.dataset.type;
  const on = favoriteSet(type).has(star.dataset.favorite);
  star.textContent = on ? '★' : '☆';
  // Plusieurs pages : l'infobulle dit laquelle.
  star.title = favoritePages[type].length > 1
    ? t(on ? 'favorites.removeFrom' : 'favorites.addTo', { name: pageName(type, activePage[type]) })
    : t(on ? 'favorites.remove' : 'favorites.add');
  star.classList.toggle('on', on);
  star.setAttribute('aria-pressed', on);
}

function saveFavorites(type) {
  const store = FAVORITE_STORES[type];
  const pages = favoritePages[type];
  try {
    storage.setItem(store, JSON.stringify([...pages[0].ids]));
    storage.setItem(`${store}-pages`, JSON.stringify(pages.map((page, i) => (i ? { name: page.name, ids: [...page.ids] } : { name: page.name }))));
    storage.setItem(`${store}-page`, activePage[type]);
  } catch {}
}

// Après un changement qui ne vient pas d'une étoile : étoiles, nombres, et liste de favoris affichée.
function refreshFavorites(type) {
  document.querySelectorAll(`.star[data-type="${type}"]`).forEach(paintStar);
  for (const select of [categorySelect, $('guide-category')]) if (select.dataset.type === type) labelCategories(select);
  if (type === 'live') {
    if (!$('guide').hidden && favoritePageOf($('guide-category').value) >= 0) renderGuide({ refresh: true });
  } else if (currentType === type && showingFavorites()) loadList();
}

// Autre version choisie dans le lecteur : elle prend la place des anciennes, dans toutes les pages.
function replaceFavorites(type, oldIds, newId) {
  if (!favoritePages[type]) return;
  let changed = false;
  for (const page of favoritePages[type]) {
    const ids = [...page.ids];
    if (!ids.some((id) => oldIds.includes(id))) continue;
    const at = ids.findIndex((id) => oldIds.includes(id) || id === newId);
    const kept = ids.filter((id) => !oldIds.includes(id) && id !== newId);
    kept.splice(at, 0, newId);
    page.ids.clear();
    kept.forEach((id) => page.ids.add(id));
    changed = true;
  }
  if (!changed) return;
  saveFavorites(type);
  refreshFavorites(type);
}

function toggleFavorite(type, key) {
  const set = favoriteSet(type);
  const added = !set.delete(key);
  if (added) set.add(key);
  saveFavorites(type);
  document.querySelectorAll(`.star[data-type="${type}"][data-favorite="${key}"]`).forEach(paintStar);
  for (const select of [categorySelect, $('guide-category')]) if (select.dataset.type === type) labelCategories(select);
  if (type === 'live') {
    if (!$('guide').hidden && favoritePageOf($('guide-category').value) >= 0) renderGuide({ refresh: true });
    return;
  }
  // Liste des favoris affichée : retirée sur place, sans perdre le défilement ; ajoutée depuis la fiche, on relit.
  if (currentType !== type || !showingFavorites()) return;
  if (added) return loadList();
  list.querySelector(`li[data-id="${key}"]`)?.remove();
  if (!list.children.length) list.append(noFavorite());
}

function favoriteStar(type, id) {
  const star = el('button', {
    className: 'star',
    onclick: (e) => {
      e.stopPropagation();
      toggleFavorite(type, star.dataset.favorite);
    },
  });
  star.dataset.type = type;
  star.dataset.favorite = id;
  paintStar(star);
  return star;
}

// Les favoris se réordonnent en les faisant glisser.
let draggedFavorite = null;

// `refresh` : réaffichage après coup, si la liste en a besoin.
function sortFavoritesIn(container, type, refresh) {
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
    const kind = typeof type === 'function' ? type() : type;
    const set = favoriteSet(kind);
    const others = [...set].filter((id) => !shown.includes(id));
    set.clear();
    [...shown, ...others].forEach((id) => set.add(id));
    saveFavorites(kind);
    refresh?.();
  });
}
sortFavoritesIn($('guide-list'), 'live', () => renderGuide({ refresh: true })); // la mise à jour de la minute a pu être sautée
sortFavoritesIn(list, () => currentType);

// Soirée : 21h15, pour tomber sur le programme de début de soirée (souvent 21h10).
// Passé cette heure, c'est celle du lendemain.
function evening() {
  const date = new Date();
  date.setHours(21, 15, 0, 0);
  const tomorrow = Date.now() >= date;
  if (tomorrow) date.setDate(date.getDate() + 1);
  return { at: Math.floor(date / 1000), label: t(tomorrow ? 'guide.tomorrowNight' : 'guide.tonight') };
}

// Un programme de la ligne : une seule ligne de texte, le détail est dans l'infobulle et la fiche.
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
  if (document.body.classList.contains('no-player')) query.set('evening', evening().at);
  const page = favoritePageOf(category);
  if (page >= 0 && !q) query.set('ids', [...favoritePages.live[page].ids].join());
  else if (page < 0) query.set('category', category);
  return getJson(`/api/guide?${query}`);
}

function guideRow(channel, sortable) {
  if (channel.separator) return el('div', { className: 'guide-separator' }, channel.name.replace(/^#+\s*|\s*#+$/g, ''));
  const [programme, next] = channel.programmes;
  // Grille large : maintenant, à suivre, ce soir. Les deux dernières ne s'affichent qu'à côté de la première.
  const cell = (p) => (p ? guideProgramme(p) : el('div', { className: 'guide-programme' }));
  const any = programme || channel.evening;
  const row = el(
    'div',
    {
      className: 'guide-row',
      title: t('guide.rowTitle', { name: channel.name }),
      onclick: () => {
        // Même ligne : la fiche se replie, ou se rouvre telle quelle.
        if (selectedChannel === String(channel.id)) return closeFiche(ficheOpen());
        closeFiche(false);
        showChannel(channel);
      },
    },
    el('button', {
      className: 'guide-play',
      textContent: '▶',
      title: t('guide.playTitle', { name: channel.name }),
      onclick: (e) => {
        e.stopPropagation();
        playLive(channel); // la fiche ne s'ouvre qu'au clic sur le reste de la ligne
      },
    }),
    el('div', { className: 'guide-logo' }, channel.logo && el('img', { src: channel.logo, loading: 'lazy', onerror: (e) => e.target.remove() })),
    el('span', { className: `guide-name${any ? '' : ' wide'}` }, channel.name),
    any && cell(programme),
    any && el('div', { className: 'guide-more' }, cell(next), cell(channel.evening)),
    el('div', { className: 'guide-replay' }, channel.archiveDays > 0 && el('small', { className: 'badge', title: t('guide.replayDays', { count: channel.archiveDays }) }, '⟲')),
    favoriteStar('live', channel.id),
  );
  row.dataset.id = channel.id;
  row.draggable = sortable;
  return row;
}

// Recherche dans le guide : les programmes dont le titre correspond, au-dessus des chaînes.
// En cours et à venir : ▶ lance la chaîne ; passés : ⟲ les revoit (replay). Le reste de la ligne ouvre la fiche.
const PROGRAMMES_SHOWN = 5;
let programmesQuery = '';
let programmesExpanded = false;

function programmeRow(p) {
  const now = Date.now() / 1000;
  const onAir = p.start <= now && p.stop > now;
  const canReplay = p.archive && p.channel.archiveDays > 0;
  const date = new Date(p.start * 1000);
  const day = date.toDateString() === new Date().toDateString() ? '' : `${date.toLocaleDateString(language, { weekday: 'short', day: 'numeric', month: 'short' })} · `;
  return el(
    'div',
    {
      className: `guide-row programme-result${onAir ? ' live' : ''}`,
      title: [`${formatHour(p.start)} – ${formatHour(p.stop)} · ${p.title}`, p.description].filter(Boolean).join('\n'),
      onclick: () => {
        closeFiche(false);
        showChannel(p.channel);
      },
    },
    p.stop > now || canReplay
      ? el('button', {
          className: 'guide-play',
          textContent: p.stop > now ? '▶' : '⟲',
          title: p.stop > now ? t('guide.playTitle', { name: p.channel.name }) : t('channel.replayTitle'),
          onclick: (e) => {
            e.stopPropagation();
            if (p.stop > now) playLive(p.channel);
            else playReplay(p.channel, p);
          },
        })
      : el('span'),
    el('div', { className: 'guide-logo' }, p.channel.logo && el('img', { src: p.channel.logo, loading: 'lazy', onerror: (e) => e.target.remove() })),
    el('span', { className: 'guide-name' }, p.title),
    el(
      'div',
      { className: 'programme-when' },
      el('span', { className: onAir ? 'on-air' : 'muted' }, onAir ? t('guide.onAir') : `${day}${formatHour(p.start)}`),
      el('span', { className: 'muted' }, p.channel.name),
      onAir && el('div', { className: 'bar' }, el('div', { style: `width:${((now - p.start) / (p.stop - p.start)) * 100}%` })),
    ),
  );
}

function programmeResults(programmes) {
  if (!programmes.length) return [];
  const rows = programmes.map(programmeRow);
  const hidden = programmesExpanded ? [] : rows.slice(PROGRAMMES_SHOWN);
  hidden.forEach((row) => (row.hidden = true));
  const more =
    hidden.length > 0 &&
    el('button', {
      className: 'secondary programmes-more',
      textContent: t('guide.morePrograms', { count: hidden.length }),
      onclick: (e) => {
        programmesExpanded = true;
        hidden.forEach((row) => (row.hidden = false));
        e.target.remove();
      },
    });
  return [el('div', { className: 'guide-separator' }, t('guide.programs')), ...rows, more].filter(Boolean);
}

// `append` : page suivante. `refresh` : relit ce qui est déjà affiché, sans bouger la liste.
async function renderGuide({ append = false, refresh = false } = {}) {
  clearTimeout(guideTimer);
  const load = ++guideLoad;
  const search = $('guide-search').value.trim();
  if (search !== programmesQuery) programmesExpanded = false;
  programmesQuery = search;
  const programmes = !append && search
    ? getJson(`/api/programmes?${new URLSearchParams({ q: search, at: Math.floor(Date.now() / 1000) })}`).catch(() => [])
    : Promise.resolve([]);

  const channels = [];
  let page;
  do {
    page = await guidePage(append ? guideOffset : channels.length);
    if (load !== guideLoad) return; // une demande plus récente est partie entre-temps
    channels.push(...page);
  } while (refresh && page.length === PAGE && channels.length < guideOffset);

  const box = $('guide-list');
  $('guide-evening').textContent = evening().label;
  const q = $('guide-search').value.trim();
  const showFavorites = favoritePageOf($('guide-category').value) >= 0 && !q;
  const nodes = channels.map((channel) => guideRow(channel, showFavorites));
  const found = programmeResults(await programmes);
  if (load !== guideLoad) return;
  if (found.length && nodes.length) nodes.unshift(...found, el('div', { className: 'guide-separator' }, t('guide.channels')));
  else nodes.unshift(...found);
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
      el('p', { className: 'muted' }, t(showFavorites ? 'favorites.noneChannels' : q ? 'guide.noResult' : 'guide.noChannel')),
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
  fillCategories(select, 'live', categories);
  select.value = first ? defaultCategory('live') : chosen;
  if (select.selectedIndex < 0) select.value = ''; // catégorie disparue du catalogue
  select.dataset.current = select.value;
  paintPageEdit();
  $('guide-search').value = '';
  if (first) {
    select.onchange = () => categoryChanged(select, () => renderGuide());
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

// Comme pour la TV, la recherche porte sur tout le catalogue, même depuis les favoris.
const showingFavorites = () => favoritePageOf(categorySelect.value) >= 0 && !searchInput.value.trim();

function noFavorite() {
  return el('li', { className: 'muted empty' }, t(currentType === 'series' ? 'favorites.noneSeries' : 'favorites.noneMovies'));
}

async function loadList(append = false) {
  if (!append) offset = 0;
  const type = currentType;
  const favoritesOnly = showingFavorites();
  const params = new URLSearchParams({ type, q: searchInput.value.trim(), offset });
  const page = favoritePageOf(categorySelect.value);
  if (favoritesOnly) params.set('ids', [...favoritePages[type][page].ids].join());
  else if (page < 0) params.set('category', categorySelect.value);
  const items = await getJson(`/api/list?${params}`);
  if (type !== currentType) return; // onglet changé entre-temps
  offset += items.length;
  $('more').hidden = items.length < PAGE;

  const nodes = items.map((item) => {
    const li = el(
      'li',
      { className: 'poster', title: item.name },
      item.logo && el('img', { src: item.logo, loading: 'lazy', onerror: (e) => e.target.remove() }),
      el('span', {}, item.name),
      favoriteStar(type, String(item.id)),
    );
    li.dataset.id = item.id;
    li.draggable = favoritesOnly; // les favoris se réordonnent en les faisant glisser
    li.onclick = () => {
      if (li.classList.contains('active')) return closeFiche(ficheOpen()); // même ligne : repliée ou rouverte
      list.querySelector('.active')?.classList.remove('active');
      li.classList.add('active');
      handlers[type](item);
    };
    return li;
  });
  if (append) list.append(...nodes);
  else {
    list.replaceChildren(...nodes);
    list.scrollTop = 0;
    if (!nodes.length && favoritesOnly) list.append(noFavorite());
  }
  paintNowPlaying();
}

const chosenCategory = {}; // par onglet : la catégorie retrouvée en y revenant

// Menu des catégories, chacune avec son nombre d'éléments : « Ligue 1 (21) ».
const withCount = (text, count) => `${text} (${Number(count).toLocaleString(language)})`;

function fillCategories(select, type, categories) {
  select.dataset.type = type;
  select.categories = categories; // gardées pour refaire la liste quand les pages de favoris changent
  select.dataset.total = categories.reduce((sum, c) => sum + c.count, 0);
  select.replaceChildren(
    new Option('', ''),
    ...favoritePages[type].map((_, index) => {
      const option = new Option('', pageValue(index));
      option.dataset.page = index;
      return option;
    }),
    new Option('', NEW_PAGE),
    ...categories.map((c) => {
      const option = new Option('', c.id);
      Object.assign(option.dataset, { name: c.name, count: c.count });
      return option;
    }),
  );
  labelCategories(select);
}

// Les premières entrées : traduites, et le nombre de favoris change avec les étoiles.
// Les nombres des groupes suivent aussi la langue (séparateur des milliers).
function labelCategories(select) {
  const type = select.dataset.type;
  if (!type) return;
  for (const option of select.options) {
    if (option.value === '') option.text = withCount(t('list.allCategories'), select.dataset.total);
    else if (option.value === NEW_PAGE) option.text = t('favorites.newPage');
    else if (option.dataset.page) option.text = withCount(pageLabel(type, Number(option.dataset.page)), favoritePages[type][option.dataset.page].ids.size);
    else option.text = withCount(option.dataset.name, option.dataset.count);
  }
}

async function selectType(type) {
  currentType = type;
  paintView();
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
  fillCategories(categorySelect, type, categories);
  categorySelect.value = chosenCategory[type] ?? defaultCategory(type);
  if (categorySelect.selectedIndex < 0) categorySelect.value = ''; // catégorie disparue du catalogue
  chosenCategory[type] = categorySelect.value;
  categorySelect.dataset.current = categorySelect.value;
  paintPageEdit();
  await loadList();
  searchInput.focus();
}

// --- Pages de favoris : ajout, nom, suppression -------------------------------------

// Choix dans la liste des catégories : une page de favoris devient celle des étoiles ; « Nouvelle page » ouvre l'éditeur.
function categoryChanged(select, render) {
  const type = select.dataset.type;
  if (select.value === NEW_PAGE) {
    select.value = select.dataset.current ?? '';
    return editFavoritePage(select, null);
  }
  select.dataset.current = select.value;
  const page = favoritePageOf(select.value);
  if (page >= 0 && page !== activePage[type]) {
    activePage[type] = page;
    saveFavorites(type);
    document.querySelectorAll(`.star[data-type="${type}"]`).forEach(paintStar);
  }
  paintPageEdit();
  render();
}

// ✎ à côté de la liste : seulement sur une page de favoris.
function paintPageEdit() {
  $('guide-page-edit').hidden = favoritePageOf($('guide-category').value) < 0;
  $('page-edit').hidden = favoritePageOf(categorySelect.value) < 0;
}

let pageEditing = null; // { select, type, index } ; index null : nouvelle page

function editFavoritePage(select, index) {
  const type = select.dataset.type;
  pageEditing = { select, type, index };
  $('page-editor-title').textContent = t(index === null ? 'favorites.addPage' : 'favorites.editPage');
  $('page-name').value = index === null ? '' : favoritePages[type][index].name;
  $('page-name').placeholder = index === 0 ? t('favorites.defaultName') : '';
  $('page-name').required = index !== 0; // la première, sans nom, reprend « Favoris »
  $('page-delete').hidden = !index;
  $('page-editor').hidden = false;
  $('page-name').focus();
}

function closePageEditor() {
  $('page-editor').hidden = true;
  pageEditing = null;
}

// Pages ajoutées, renommées ou supprimées : la liste est refaite ; `page` : celle à afficher.
function pagesChanged(select, page) {
  const type = select.dataset.type;
  const value = page === undefined ? select.value : pageValue(page);
  fillCategories(select, type, select.categories);
  select.value = value;
  if (select.selectedIndex < 0) select.value = pageValue(0);
  select.dataset.current = select.value;
  document.querySelectorAll(`.star[data-type="${type}"]`).forEach(paintStar);
  paintPageEdit();
  if (page === undefined) return;
  if (type === 'live') return renderGuide();
  chosenCategory[type] = select.value;
  loadList();
}

$('page-form').onsubmit = (event) => {
  event.preventDefault();
  const { select, type, index } = pageEditing;
  const name = $('page-name').value.trim().slice(0, 40);
  if (!name && index !== 0) return $('page-name').focus();
  if (index === null) {
    favoritePages[type].push({ name, ids: new Set() });
    activePage[type] = favoritePages[type].length - 1;
  } else favoritePages[type][index].name = name;
  saveFavorites(type);
  closePageEditor();
  pagesChanged(select, index === null ? activePage[type] : undefined);
};

$('page-delete').onclick = () => {
  const { select, type, index } = pageEditing;
  const page = favoritePages[type][index];
  if (!confirm(t('favorites.deleteConfirm', { name: page.name, count: page.ids.size }))) return;
  favoritePages[type].splice(index, 1);
  activePage[type] = 0;
  saveFavorites(type);
  closePageEditor();
  pagesChanged(select, 0);
};

$('page-cancel').onclick = closePageEditor;
$('page-editor').querySelector('.close').onclick = closePageEditor;
document.addEventListener('keydown', (event) => event.key === 'Escape' && !$('page-editor').hidden && closePageEditor());
$('guide-page-edit').onclick = () => editFavoritePage($('guide-category'), favoritePageOf($('guide-category').value));
$('page-edit').onclick = () => editFavoritePage(categorySelect, favoritePageOf(categorySelect.value));

// --- Réglages : chaînes et groupes -------------------------------------------------

const MANAGED_TYPES = ['live', 'vod', 'series']; // libellés : ceux des onglets
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
    $('manage-note').textContent = t('settings.manageFailed', { error: err.message });
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
    return box.replaceChildren(el('li', { className: 'muted' }, t('settings.pickGroup')));
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
        title: item.groupHidden ? t('settings.groupHidden') : item.name,
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
    if (!nodes.length) box.append(el('li', { className: 'muted' }, t('settings.noResult')));
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

// Fiches des films et séries dans la langue de l'appli (traduites par TMDB côté serveur).
const languageParam = () => new URLSearchParams({ language });

// Réglages en rubriques, une seule affichée à la fois ; la dernière ouverte est retenue.
const SETTINGS_PANES = ['subscription', 'profiles', 'manage', 'preferences'];
let settingsPane = SETTINGS_PANES.includes(storage.getItem('settingsPane')) ? storage.getItem('settingsPane') : 'subscription';

function showPane(name) {
  settingsPane = name;
  storage.setItem('settingsPane', name);
  document.querySelectorAll('#settings-menu button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  document.querySelectorAll('.settings-pane').forEach((pane) => (pane.hidden = pane.dataset.pane !== name));
  if (name === 'profiles') renderAccounts();
  if (name === 'manage') return selectManagedType(managedType);
}

function showSettings() {
  document.querySelectorAll('#settings-menu button').forEach((b) => (b.onclick = () => showPane(b.dataset.pane)));
  if (!$('manage-types').children.length) {
    $('manage-types').append(
      ...MANAGED_TYPES.map((type) => {
        const button = el('button', { className: 'secondary', onclick: () => selectManagedType(type) });
        button.dataset.type = type;
        button.dataset.i18n = `tabs.${type}`;
        button.textContent = t(button.dataset.i18n);
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
  return showPane(settingsPane);
}

// --- Comptes ----------------------------------------------------------------------

let account = null; // compte en cours : { id, name, role, locked, groups }
let accounts = []; // tous les comptes, sans leurs mots de passe
const isAdmin = () => account?.role === 'admin';
const ROLE_KEYS = { admin: 'profiles.roleAdmin', standard: 'profiles.roleStandard', child: 'profiles.roleChild' };
const fold = (text) => text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
const sendJson = (url, method, body) =>
  getJson(url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });

// Pastille avec l'initiale, d'une couleur propre au compte.
function avatar(profile, className = 'avatar') {
  const node = el('span', { className, textContent: [...profile.name.trim()][0]?.toUpperCase() || '?' });
  node.style.background = `hsl(${(profile.id * 137) % 360} 45% 38%)`;
  return node;
}

// Les données du navigateur sont rangées par compte : la page est rechargée pour prendre les bonnes.
function enterProfile(id) {
  try {
    sessionStorage.setItem('profile', id);
  } catch {}
  location.reload();
}

async function leaveProfile() {
  stopPlayback();
  await getJson('/api/profiles/leave', { method: 'POST' }).catch(() => {});
  try {
    sessionStorage.removeItem('profile');
  } catch {}
  location.reload();
}

// Écran « Qui regarde ? », à l'ouverture.
function showProfiles(list) {
  $('profiles').hidden = false;
  const form = $('profile-unlock');
  let chosen = null;
  const enter = async (profile, password) => {
    $('profiles-text').textContent = '';
    try {
      await sendJson('/api/profiles/select', 'POST', { id: profile.id, password });
      enterProfile(profile.id);
    } catch (err) {
      $('profiles-text').textContent = err.message;
      $('profile-password').select();
    }
  };
  const cards = list.map((profile) => {
    const card = el(
      'button',
      { type: 'button', className: 'profile-card' },
      avatar(profile, 'avatar big'),
      el('span', {}, profile.name),
      profile.locked && el('small', { className: 'lock', textContent: '🔒' }),
    );
    card.onclick = () => {
      if (!profile.locked) return enter(profile);
      chosen = profile;
      cards.forEach((c) => c.classList.toggle('active', c === card));
      form.hidden = false;
      $('profiles-text').textContent = '';
      $('profile-password').value = '';
      $('profile-password').focus();
    };
    return card;
  });
  $('profile-cards').replaceChildren(...cards);
  form.onsubmit = (event) => {
    event.preventDefault();
    if (chosen) enter(chosen, $('profile-password').value);
  };
}

// Pastille du compte dans la barre d'onglets : un clic pour changer de compte.
function showAccount() {
  const button = $('profile-button');
  button.hidden = accounts.length < 2 && !account.locked;
  button.replaceChildren(avatar(account));
  button.title = t('profiles.switch', { name: account.name });
  document.querySelector('#tabs button[data-type="settings"]').hidden = !isAdmin();
}
$('profile-button').onclick = leaveProfile;

async function loadAccounts() {
  accounts = (await getJson('/api/profiles')).profiles;
}

// Efface les données d'un compte supprimé (ou d'un ancien compte au même numéro).
function forgetProfileData(id) {
  const prefix = scoped('', id);
  if (!prefix) return;
  try {
    Object.keys(localStorage).filter((key) => key.startsWith(prefix)).forEach((key) => localStorage.removeItem(key));
  } catch {}
}

function groupSummary(profile) {
  if (!profile.groups) return t('profiles.allGroups');
  return t('profiles.groupCount', { count: Object.values(profile.groups).reduce((sum, ids) => sum + ids.length, 0) });
}

function renderAccounts() {
  if (!isAdmin()) return;
  $('profile-list').replaceChildren(
    ...accounts.map((profile) =>
      el(
        'li',
        {},
        avatar(profile),
        el('span', { className: 'name' }, profile.name),
        el('small', { className: 'muted' }, [
          t(ROLE_KEYS[profile.role]),
          profile.role !== 'admin' && groupSummary(profile),
          profile.locked && `🔒 ${t('profiles.locked')}`,
          profile.id === account.id && t('profiles.current'),
        ].filter(Boolean).join(' · ')),
        el('button', { className: 'secondary', textContent: t('profiles.edit'), onclick: () => editProfile(profile) }),
        profile.id !== account.id && el('button', { className: 'secondary', textContent: t('profiles.delete'), onclick: () => deleteProfile(profile) }),
      ),
    ),
  );
}

async function deleteProfile(profile) {
  if (!confirm(t('profiles.deleteConfirm', { name: profile.name }))) return;
  try {
    await sendJson(`/api/profiles/${profile.id}`, 'DELETE');
  } catch (err) {
    return alert(err.message);
  }
  forgetProfileData(profile.id);
  await loadAccounts();
  renderAccounts();
  showAccount();
}

// Éditeur d'un compte : nom, type, mot de passe et groupes visibles.
const editor = { profile: null, groups: {}, type: 'live', categories: {} };

async function editProfile(profile) {
  editor.profile = profile; // null : nouveau compte
  editor.categories = {};
  editor.groups = Object.fromEntries(MANAGED_TYPES.map((type) => [type, new Set(profile?.groups?.[type] ?? [])]));
  $('profile-editor-title').textContent = profile ? t('profiles.editTitle', { name: profile.name }) : t('profiles.addTitle');
  $('profile-name').value = profile?.name ?? '';
  $('profile-role').value = profile?.role ?? 'child';
  $('profile-new-password').value = '';
  $('profile-new-password').dataset.i18nPlaceholder = profile?.locked ? 'profiles.passwordKeep' : 'profiles.passwordNone';
  $('profile-new-password').placeholder = t($('profile-new-password').dataset.i18nPlaceholder);
  $('profile-no-password').checked = false;
  $('profile-no-password-row').hidden = !profile?.locked;
  $('profile-all-groups').checked = profile ? !profile.groups : false;
  $('profile-group-search').value = '';
  $('profile-error').textContent = '';
  $('profile-editor').hidden = false;
  paintRole();
  $('profile-name').focus();
  await pickGroupType('live');
}

function paintRole() {
  const role = $('profile-role').value;
  $('profile-role-note').textContent = t(`profiles.note${role[0].toUpperCase()}${role.slice(1)}`);
  $('profile-groups').hidden = role === 'admin';
  $('profile-group-picker').hidden = $('profile-all-groups').checked;
  paintGroupCount();
}

function paintGroupCount() {
  const count = Object.values(editor.groups).reduce((sum, set) => sum + set.size, 0);
  $('profile-group-count').textContent = t('profiles.groupCount', { count });
}

async function pickGroupType(type) {
  editor.type = type;
  if (!$('profile-types').children.length) {
    $('profile-types').append(
      ...MANAGED_TYPES.map((value) => {
        const button = el('button', { type: 'button', className: 'secondary', onclick: () => pickGroupType(value) });
        button.dataset.type = value;
        button.dataset.i18n = `tabs.${value}`;
        button.textContent = t(button.dataset.i18n);
        return button;
      }),
    );
  }
  $('profile-types').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.type === type));
  try {
    editor.categories[type] ??= await getJson(`/api/manage/categories?type=${type}`);
  } catch (err) {
    $('profile-error').textContent = err.message;
    editor.categories[type] = [];
  }
  if (editor.type === type) renderGroupChoices();
}

const shownGroupChoices = () => {
  const q = fold($('profile-group-search').value.trim());
  return (editor.categories[editor.type] || []).filter((c) => !q || fold(c.name).includes(q));
};

function renderGroupChoices() {
  const chosen = editor.groups[editor.type];
  $('profile-group-list').replaceChildren(
    ...shownGroupChoices().map((c) => {
      const box = el('input', { type: 'checkbox', checked: chosen.has(c.id) });
      const li = el('li', { className: c.hidden ? 'removed' : '' }, box, el('span', {}, c.name), el('small', { className: 'muted' }, String(c.total)));
      li.onclick = (event) => {
        if (event.target !== box) box.checked = !box.checked;
        if (box.checked) chosen.add(c.id);
        else chosen.delete(c.id);
        paintGroupCount();
      };
      return li;
    }),
  );
  paintGroupCount();
}

function closeEditor() {
  $('profile-editor').hidden = true;
}

$('profile-add').onclick = () => editProfile(null);
$('profile-role').onchange = () => {
  // Nouveau compte : un enfant part de rien, un compte standard de tout.
  if (!editor.profile) $('profile-all-groups').checked = $('profile-role').value === 'standard';
  paintRole();
};
$('profile-all-groups').onchange = paintRole;
$('profile-group-search').oninput = renderGroupChoices;
for (const [id, on] of [['profile-check', true], ['profile-uncheck', false]]) {
  $(id).onclick = () => {
    const chosen = editor.groups[editor.type];
    shownGroupChoices().forEach((c) => (on ? chosen.add(c.id) : chosen.delete(c.id)));
    renderGroupChoices();
  };
}
$('profile-editor').querySelector('.close').onclick = closeEditor;
$('profile-cancel').onclick = closeEditor;
$('profile-editor').addEventListener('mousedown', (event) => event.target === $('profile-editor') && closeEditor());
document.addEventListener('keydown', (event) => event.key === 'Escape' && !$('profile-editor').hidden && closeEditor());

$('profile-form').onsubmit = async (event) => {
  event.preventDefault();
  const role = $('profile-role').value;
  const body = { name: $('profile-name').value.trim(), role };
  const password = $('profile-new-password').value;
  if (password) body.password = password;
  else if ($('profile-no-password').checked) body.password = '';
  if (role !== 'admin') {
    body.groups = $('profile-all-groups').checked ? null : Object.fromEntries(MANAGED_TYPES.map((type) => [type, [...editor.groups[type]]]));
  }
  try {
    if (editor.profile) await sendJson(`/api/profiles/${editor.profile.id}`, 'PUT', body);
    else forgetProfileData((await sendJson('/api/profiles', 'POST', body)).id);
  } catch (err) {
    $('profile-error').textContent = err.message;
    return;
  }
  closeEditor();
  if (editor.profile?.id === account.id) return location.reload(); // ses propres droits ont pu changer
  await loadAccounts();
  renderAccounts();
  showAccount();
};

// --- Démarrage et import -----------------------------------------------------------

let syncStatus = null; // dernier état connu, réaffiché si la langue change

function showSyncInfo(status) {
  syncStatus = status;
  const format = (date) => new Date(date).toLocaleString(language, { dateStyle: 'short', timeStyle: 'short' });
  const counts = MANAGED_TYPES.filter((type) => status.counts?.[type])
    .map((type) => t(`settings.count.${type}`, { count: status.counts[type] })).join(' · ');
  const rows = status.syncedAt ? [
    ['settings.user', status.account?.username],
    ['settings.server', status.account?.server],
    ['settings.catalogue', `${format(status.syncedAt)}${counts ? ` — ${counts}` : ''}`],
    ['settings.guide', status.epgSyncedAt && format(status.epgSyncedAt)],
  ] : [];
  $('sync-info').replaceChildren(...rows.filter(([, value]) => value)
    .flatMap(([key, value]) => [el('dt', {}, t(key)), el('dd', {}, value)]));
  $('sync').hidden = $('logout').hidden = !status.syncedAt;
  $('tmdb-note').hidden = !status.tmdb; // attribution demandée par TMDB
  onlineSubtitles = false; // recherche OpenSubtitles mise de côté pour l'instant (status.opensubtitles)
}

// Tout ce qui est déjà affiché passe dans la nouvelle langue, sans toucher à la lecture.
async function refreshTexts() {
  if (statusMessage) say(statusMessage.key, statusMessage.vars, statusMessage.isError);
  renderPlaylist();
  document.querySelectorAll('.star').forEach(paintStar);
  if (syncStatus) showSyncInfo(syncStatus);
  if (account) showAccount();
  if (!$('profile-editor').hidden) paintRole();
  if ($('app').hidden) return;
  labelCategories(categorySelect);
  labelCategories($('guide-category'));
  if (media?.subtitles) {
    const chosen = subtitleSelect.value;
    fillSubtitles();
    subtitleSelect.value = chosen;
    showDelay();
  }
  const ficheClosed = document.body.classList.contains('fiche-closed');
  if (currentType === 'settings') {
    renderAccounts();
    if (settingsPane === 'manage') await renderManagedItems();
  }
  else if (currentType === 'live') await renderGuide({ refresh: true });
  else list.querySelector('.empty')?.replaceWith(noFavorite());
  await shownFiche?.();
  closeFiche(ficheClosed);
}

async function runImport(button) {
  button.disabled = true;
  const label = button.textContent;
  button.textContent = t('settings.importing');
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
  categorySelect.onchange = () =>
    categoryChanged(categorySelect, () => {
      chosenCategory[currentType] = categorySelect.value;
      searchInput.focus();
      loadList();
    });
  $('more').onclick = () => loadList(true);
  await selectType('live');
}

async function init() {
  await loadLanguage(initialLanguage());
  const { current, profiles } = await getJson('/api/profiles');
  accounts = profiles;
  if (!current) return showProfiles(profiles);
  // Compte choisi d'office (un seul, sans mot de passe) ou autre que celui de la page : on recharge.
  if (String(current.id) !== profileId) {
    enterProfile(current.id);
    return new Promise(() => {}); // l'écran de chargement reste jusqu'au rechargement
  }
  account = current;
  showAccount();
  say('player.idle');
  renderPlaylist();
  const status = await getJson('/api/status');
  showSyncInfo(status);
  $('sync').onclick = async () => {
    $('sync-error').textContent = '';
    try {
      await runImport($('sync'));
      await selectType(currentType);
    } catch (err) {
      $('sync-error').textContent = t('settings.syncFailed', { error: err.message });
    }
  };

  $('logout').onclick = async () => {
    if (!confirm(t('settings.logoutConfirm'))) return;
    stopPlayback();
    try {
      await getJson('/api/logout', { method: 'POST' });
      playlist.length = 0;
      savePlaylist();
      location.reload();
    } catch (err) {
      $('sync-error').textContent = t('settings.logoutFailed', { error: err.message });
    }
  };

  if (Object.keys(status.counts).length) return startApp();
  if (!isAdmin()) throw new Error(t('profiles.noCatalog'));

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
    if (!credentials) return message(t('onboarding.notFound', { source }), true);
    for (const [name, value] of Object.entries(credentials)) form.elements[name].value = value;
    message(t('onboarding.found', { source }));
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
  $('m3u-link').oninput = (event) => event.target.value && fill(credentialsFromUrl(event.target.value), t('onboarding.theLink'));

  form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $('import');
    button.disabled = true;
    button.textContent = t('onboarding.connecting');
    try {
      await getJson('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      message(t('onboarding.connected'));
      await runImport(button);
      startApp();
    } catch (err) {
      message(err.message, true);
    } finally {
      button.disabled = false;
      button.textContent = t('onboarding.submit');
    }
  };
}

init()
  .then(() => {
    $('loading').hidden = true;
  })
  .catch((err) => {
    document.querySelector('#loading .spinner').hidden = true;
    $('loading-text').textContent = t('loading.failed', { error: err.message });
  });
