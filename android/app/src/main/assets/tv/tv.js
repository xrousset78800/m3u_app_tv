// Appli Android TV : la page de l'appli Windows, adaptée à la télé.
// - Le <video> de la page est piloté par le lecteur natif (ExoPlayer), affiché sous la page transparente.
// - La télécommande (croix, OK, retour) remplace la souris.
// Chargé juste avant app.js.
(() => {
  'use strict';
  const native = window.TVNative;
  if (!native) return;

  // --- Le <video> natif ---------------------------------------------------------------

  const video = document.getElementById('video');
  const fire = (name) => video.dispatchEvent(new Event(name));
  const absolute = (src) => new URL(src, location.href).href;

  let gen = 0; // numéro de la demande en cours : les états d'une lecture précédente sont ignorés
  let src = '';
  let st = { t: 0, d: NaN, rs: 0, buf: 0, w: 0, h: 0, ended: false };
  let paused = true;
  let commandAt = 0; // dernier play()/pause() : l'état natif peut avoir un temps de retard
  let seeking = false;
  let lastSeek = 0;
  let volume = 1;
  let muted = false;
  let rate = 1;
  let defaultRate = 1;
  let error = null;

  function reset() {
    st = { t: 0, d: NaN, rs: 0, buf: 0, w: 0, h: 0, ended: false };
    seeking = false;
    lastSeek = 0;
    error = null;
  }

  function setSrc(value) {
    const had = Boolean(src);
    reset();
    src = value ? absolute(value) : '';
    if (had) fire('emptied');
    if (!src) {
      native.detach();
      return;
    }
    gen++;
    paused = false; // autoplay
    commandAt = Date.now();
    native.load(gen, src);
    fire('loadstart');
    fire('play');
  }

  const ranges = (list) => ({
    length: list.length,
    start: (i) => list[i][0],
    end: (i) => list[i][1],
  });

  const props = {
    src: { get: () => src, set: (v) => setSrc(String(v || '')) },
    currentSrc: { get: () => src },
    currentTime: {
      get: () => st.t,
      set(v) {
        v = Number(v);
        if (!src || !Number.isFinite(v)) return;
        st.t = Math.max(0, v);
        lastSeek = st.t;
        seeking = true;
        st.ended = false;
        native.seek(st.t);
        fire('seeking');
        fire('timeupdate');
      },
    },
    duration: { get: () => st.d },
    paused: { get: () => paused },
    ended: { get: () => st.ended },
    seeking: { get: () => seeking },
    readyState: { get: () => (src ? st.rs : 0) },
    networkState: { get: () => (src ? 2 : 0) },
    buffered: {
      get: () => {
        if (!src || !(st.buf > 0)) return ranges([]);
        const end = Math.max(st.buf, st.t);
        return ranges([[Math.min(st.t, Math.max(lastSeek, st.t - 55)), end]]);
      },
    },
    seekable: { get: () => ranges(Number.isFinite(st.d) ? [[0, st.d]] : []) },
    videoWidth: { get: () => st.w },
    videoHeight: { get: () => st.h },
    error: { get: () => error },
    volume: {
      get: () => volume,
      set(v) {
        v = Math.max(0, Math.min(1, Number(v)));
        if (v === volume || Number.isNaN(v)) return;
        volume = v;
        native.setVolume(muted ? 0 : volume);
        fire('volumechange');
      },
    },
    muted: {
      get: () => muted,
      set(v) {
        v = Boolean(v);
        if (v === muted) return;
        muted = v;
        native.setVolume(muted ? 0 : volume);
        fire('volumechange');
      },
    },
    playbackRate: {
      get: () => rate,
      set(v) {
        v = Number(v);
        if (!(v > 0) || v === rate) return;
        rate = v;
        native.setRate(rate);
        fire('ratechange');
      },
    },
    defaultPlaybackRate: { get: () => defaultRate, set: (v) => (defaultRate = Number(v) || 1) },
  };
  for (const [name, desc] of Object.entries(props)) Object.defineProperty(video, name, { configurable: true, ...desc });

  video.play = () => {
    if (!src) return Promise.reject(new DOMException('Aucune source', 'NotSupportedError'));
    if (st.ended) video.currentTime = 0;
    commandAt = Date.now();
    native.play();
    if (paused) {
      paused = false;
      fire('play');
    }
    return Promise.resolve();
  };
  video.pause = () => {
    commandAt = Date.now();
    native.pause();
    if (!paused) {
      paused = true;
      fire('pause');
    }
  };
  // removeAttribute('src') puis load() : la page lâche le flux (avant un déplacement, à la fermeture).
  video.load = () => {
    if (src) {
      const current = src;
      src = '';
      setSrc(current);
    } else {
      native.detach();
      fire('emptied');
    }
  };
  const removeAttribute = video.removeAttribute.bind(video);
  video.removeAttribute = (name) => {
    if (String(name).toLowerCase() !== 'src') return removeAttribute(name);
    if (!src) return;
    src = '';
    reset();
    if (!paused) {
      paused = true;
      fire('pause');
    }
    native.detach();
  };
  const getAttribute = video.getAttribute.bind(video);
  video.getAttribute = (name) => (String(name).toLowerCase() === 'src' ? src || null : getAttribute(name));
  const setAttribute = video.setAttribute.bind(video);
  video.setAttribute = (name, value) => (String(name).toLowerCase() === 'src' ? setSrc(String(value)) : setAttribute(name, value));
  video.hasAttribute = ((has) => (name) => (String(name).toLowerCase() === 'src' ? Boolean(src) : has(name)))(video.hasAttribute.bind(video));
  // Le lecteur natif lit le HLS et les formats de la télé : rien n'est converti.
  video.canPlayType = (type) => (/mpegurl|video\/mp4|video\/mp2t|matroska|webm/i.test(String(type)) ? 'probably' : '');
  // Image d'attente transparente : sinon le WebView dessine sa grosse icône « lecture » sur l'image native.
  setAttribute('poster', 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22/%3E');
  video.requestPictureInPicture =() => Promise.reject(new DOMException('Indisponible', 'NotSupportedError'));
  try {
    Object.defineProperty(document, 'pictureInPictureEnabled', { configurable: true, get: () => false });
  } catch {}

  // État poussé par le lecteur natif (toutes les 250 ms, et à chaque événement).
  window.tvPlayer = {
    event(s) {
      if (s.id !== gen || !src) return;
      const before = st;
      const d = s.live ? Infinity : s.d >= 0 ? s.d : NaN;
      st = { t: seeking ? st.t : s.t, d, rs: s.rs, buf: s.buf, w: s.w, h: s.h, ended: s.ended };
      const events = s.events || [];
      if (!Object.is(before.d, d)) fire('durationchange');
      if (events.includes('seeked') && seeking) {
        seeking = false;
        st.t = s.t;
        fire('seeked');
      }
      if (st.t !== before.t) fire('timeupdate');
      if (st.buf !== before.buf) fire('progress');
      if (st.w !== before.w || st.h !== before.h) fire('resize');
      if (s.paused !== paused && Date.now() - commandAt > 1000) {
        paused = s.paused;
        fire(paused ? 'pause' : 'play');
      }
      for (const name of events) {
        if (['seeked', 'loadstart', 'resize', 'durationchange'].includes(name)) continue;
        if (name === 'error') {
          error = { code: s.error?.code || 4, message: s.error?.message || '' };
          fire('error');
          continue;
        }
        if (name === 'playing' && paused) continue;
        if (name === 'ended') {
          if (!before.ended || !st.ended) st.ended = true;
          if (!paused) {
            paused = true;
            fire('pause');
          }
        }
        fire(name);
      }
      paintSubtitles();
    },
  };

  // Emplacement de la vidéo : le lecteur natif se cale sous le <video> de la page.
  let rect = '';
  function placeVideo() {
    const r = video.getBoundingClientRect();
    const shown = src && r.width > 0 && r.height > 0 && video.offsetParent !== null;
    const W = window.innerWidth || 1;
    const H = window.innerHeight || 1;
    const next = shown ? [r.left / W, r.top / H, r.width / W, r.height / H].map((n) => n.toFixed(4)).join() : '0,0,0,0';
    if (next !== rect) {
      rect = next;
      const [x, y, w, h] = next.split(',').map(Number);
      native.setRect(x, y, w, h);
    }
    placeSubtitles(r, shown);
  }
  setInterval(placeVideo, 200);
  window.addEventListener('resize', placeVideo);

  // --- Sous-titres : piste de la page, dessinée par-dessus la vidéo native ---------------

  const subs = document.createElement('div');
  subs.id = 'tv-subs';
  const tracks = [];
  video.addTextTrack = (kind, label = '', language = '') => {
    const cues = [];
    const track = {
      kind, label, language, mode: 'disabled', cues, activeCues: [],
      addCue(cue) {
        cues.push(cue);
        paintSubtitles();
      },
      removeCue(cue) {
        const i = cues.indexOf(cue);
        if (i >= 0) cues.splice(i, 1);
        paintSubtitles();
      },
      addEventListener() {},
      removeEventListener() {},
    };
    tracks.push(track);
    return track;
  };

  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Italique, gras, souligné gardés ; le reste du texte tel quel.
  const cueHtml = (text) =>
    escape(text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'))
      .replace(/&lt;(\/?)([ibu])&gt;/g, '<$1$2>')
      .replace(/&lt;[^&]*?&gt;/g, '')
      .replace(/\n/g, '<br>');

  let shownText = '';
  function paintSubtitles() {
    const t = st.t;
    const lines = [];
    for (const track of tracks) {
      if (track.mode !== 'showing') continue;
      for (const cue of track.cues) if (cue.startTime <= t && cue.endTime > t) lines.push(cue.text);
    }
    const html = lines.map(cueHtml).join('<br>');
    if (html === shownText) return;
    shownText = html;
    subs.innerHTML = html ? `<span>${html}</span>` : '';
  }
  setInterval(paintSubtitles, 250);

  function placeSubtitles(r, shown) {
    if (!subs.isConnected) document.body.append(subs);
    subs.hidden = !shown;
    if (!shown) return;
    Object.assign(subs.style, {
      left: `${r.left}px`,
      width: `${r.width}px`,
      top: `${r.top}px`,
      height: `${r.height}px`,
      fontSize: `${Math.max(16, Math.round(r.height * 0.05))}px`,
    });
  }

  // --- Fenêtre : l'appli est toujours en plein écran ; « plein écran » = la vidéo seule -----

  let fullscreen = false;
  const fullscreenListeners = [];
  window.tvWindow = {
    fullscreen(action) {
      const next = action === 'toggle' ? !fullscreen : action === 'enter';
      if (next === fullscreen) return;
      fullscreen = next;
      fullscreenListeners.forEach((listener) => listener(fullscreen));
      setTimeout(placeVideo, 50);
    },
    isFullscreen: () => Promise.resolve(fullscreen),
    onFullscreen: (listener) => fullscreenListeners.push(listener),
    focus() {},
    setLanguage() {},
  };

  // --- Télécommande --------------------------------------------------------------------

  const player = document.getElementById('player');
  const OVERLAYS = '#shortcuts, #subtitle-search, #page-editor, #profile-editor, #reminder, #up-next, .pop, [role=listbox], #versions, #sleep-menu, #view-menu';
  const visible = (el) => {
    if (!el || el.hidden || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const overlay = () => [...document.querySelectorAll(OVERLAYS)].filter((el) => !el.hidden && visible(el)).pop() || null;
  const cinema = () => document.body.classList.contains('cinema');
  const playerShown = () => !document.body.classList.contains('no-player') && visible(player);
  const awake = () => player.classList.contains('awake');
  const controlsShown = () => awake() || player.classList.contains('paused') || Boolean(player.querySelector('.pop:not([hidden])'));

  // Comme un mouvement de souris : les contrôles du lecteur restent affichés.
  function wake() {
    const r = player.getBoundingClientRect();
    const init = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    player.dispatchEvent(new MouseEvent('mousemove', init));
  }

  function press(key, target = document.activeElement || document.body) {
    const init = { key, bubbles: true, cancelable: true };
    if (key === ' ') init.code = 'Space';
    (target || document.body).dispatchEvent(new KeyboardEvent('keydown', init));
    (target || document.body).dispatchEvent(new KeyboardEvent('keyup', init));
  }

  const CANDIDATES = 'a[href], button, input, select, textarea, summary, video, [tabindex], [role=option], [role=button], [role=tab], li, .card, [data-id]';
  const NATIVE = /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/;

  function clickable(el) {
    if (el.disabled) return false;
    if (NATIVE.test(el.tagName) || el.tagName === 'VIDEO') return true;
    if (el.hasAttribute('tabindex') || el.getAttribute('role')) return true;
    return typeof el.onclick === 'function' || getComputedStyle(el).cursor === 'pointer';
  }

  function candidates() {
    const scope = overlay() || document;
    const controls = controlsShown();
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out = [];
    for (const el of scope.querySelectorAll(CANDIDATES)) {
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      // Un peu au-delà de l'écran : la liste défile pour suivre.
      if (r.bottom < -H || r.top > 2 * H || r.right < -W / 2 || r.left > W * 1.5) continue;
      if (!clickable(el) || !visible(el)) continue;
      if (el.closest('[hidden]')) continue;
      // Commandes du lecteur endormies : invisibles, donc hors d'atteinte (↑/↓ sur l'image les réveillent).
      if (!controls && el.closest('#player-head, #capsule')) continue;
      out.push({ el, r });
    }
    return out;
  }

  let focused = null;
  function focus(el) {
    if (!el) return;
    focused?.classList.remove('tv-focus');
    focused = el;
    if (!NATIVE.test(el.tagName) && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    // Champ de saisie : seulement désigné ; le clavier de la télé ne s'ouvre qu'avec OK.
    if (isText(el)) document.activeElement?.blur();
    else nativeFocus.call(el, { preventScroll: true });
    el.classList.add('tv-focus');
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // Un champ qui prend le curseur ouvre le clavier de la télé, qui capte alors la croix :
  // l'appli peut le désigner, seul OK (ou un clic) y place le curseur.
  const nativeFocus = HTMLElement.prototype.focus;
  let typingAllowed = false;
  for (const proto of [HTMLInputElement.prototype, HTMLTextAreaElement.prototype]) {
    proto.focus = function (options) {
      if (isText(this) && !typingAllowed) return focus(this);
      return nativeFocus.call(this, options);
    };
  }

  function isText(el) {
    return el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT.test(el.type));
  }

  function current() {
    const active = document.activeElement;
    const el = active && active !== document.body ? active : focused;
    if (el && el !== document.body && visible(el) && (!overlay() || overlay().contains(el))) return el;
    return null;
  }

  // Le plus proche dans la direction voulue, en privilégiant ce qui est aligné.
  function move(direction) {
    const from = current();
    const list = candidates().filter((c) => c.el !== from && !(from && c.el.contains(from)));
    if (!from) return focus(list.sort((a, b) => a.r.top - b.r.top || a.r.left - b.r.left)[0]?.el);
    const a = from.getBoundingClientRect();
    const ax = a.left + a.width / 2;
    const ay = a.top + a.height / 2;
    let best = null;
    let bestScore = Infinity;
    for (const { el, r } of list) {
      let main;
      let side;
      if (direction === 'right') {
        main = r.left - a.right;
        side = Math.max(0, Math.max(a.top, r.top) - Math.min(a.bottom, r.bottom)) || 0;
        if (r.left + 1 < a.right && r.left <= a.left) continue;
        if (r.left + r.width / 2 <= ax) continue;
      } else if (direction === 'left') {
        main = a.left - r.right;
        side = Math.max(0, Math.max(a.top, r.top) - Math.min(a.bottom, r.bottom)) || 0;
        if (r.right - 1 > a.left && r.right >= a.right) continue;
        if (r.left + r.width / 2 >= ax) continue;
      } else if (direction === 'down') {
        main = r.top - a.bottom;
        side = Math.max(0, Math.max(a.left, r.left) - Math.min(a.right, r.right)) || 0;
        if (r.top + r.height / 2 <= ay) continue;
      } else {
        main = a.top - r.bottom;
        side = Math.max(0, Math.max(a.left, r.left) - Math.min(a.right, r.right)) || 0;
        if (r.top + r.height / 2 >= ay) continue;
      }
      const centre = direction === 'left' || direction === 'right'
        ? Math.abs(r.top + r.height / 2 - ay)
        : Math.abs(r.left + r.width / 2 - ax);
      const score = Math.max(0, main) + side * 3 + centre * 0.3;
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) focus(best);
  }

  const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };
  const TEXT = /^(text|search|password|email|url|number|tel)$/;
  let synthetic = false;

  window.addEventListener('keydown', (e) => {
    if (synthetic || !e.isTrusted) return;
    const direction = ARROWS[e.key];
    const active = document.activeElement;
    const el = active && active !== document.body ? active : focused?.isConnected ? focused : active;
    const typing = el === active && el && isText(el);

    // Vidéo seule, contrôles endormis : ←/→ se déplacent dans le film (app.js), ↑/↓ réveillent, OK met en pause.
    if (cinema() && playerShown() && !overlay() && !awake()) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (el && el !== document.body) el.blur();
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (direction) {
        wake();
        focus(document.getElementById('play-button'));
      } else if (e.key === 'Enter') {
        synthetic = true;
        press(' ', document.body);
        synthetic = false;
        wake();
      }
      return;
    }

    if (direction) {
      if (typing && (direction === 'left' || direction === 'right')) return;
      if (el?.tagName === 'INPUT' && el.type === 'range' && (direction === 'left' || direction === 'right')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (playerShown() && player.contains(el)) wake();
      // Sur l'image : ↑/↓ font apparaître les commandes et vont au bouton lecture.
      if (el?.tagName === 'VIDEO' && (direction === 'up' || direction === 'down')) {
        wake();
        return focus(document.getElementById('play-button'));
      }
      move(direction);
      return;
    }
    if (e.key === 'Enter') {
      if (!el || el === document.body || typing || el.tagName === 'SELECT') return;
      if (isText(el)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        typingAllowed = true;
        el.focus({ preventScroll: true });
        typingAllowed = false;
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      if (player.contains(el)) wake();
      // OK sur l'image : vidéo seule (la souris, elle, met en pause d'un clic).
      if (el.tagName === 'VIDEO') return window.tvWindow.fullscreen('toggle');
      el.click();
    }
  }, true);

  window.tvKeys = {
    press(key) {
      synthetic = true;
      try {
        if (playerShown()) wake();
        press(key, document.body);
      } finally {
        synthetic = false;
      }
    },
    // Retour : ferme ce qui est ouvert, puis quitte la vidéo seule ; sinon l'appli passe en arrière-plan.
    back() {
      const open = overlay();
      if (open) {
        synthetic = true;
        press('Escape', document.activeElement || document.body);
        synthetic = false;
        if (overlay() === open) open.hidden = true;
        focus(candidates()[0]?.el);
        return true;
      }
      if (cinema()) {
        window.tvWindow.fullscreen('leave');
        return true;
      }
      return false;
    },
    // Appli mise de côté : la lecture s'arrête (une seule connexion par abonnement).
    hidden() {
      if (src) video.pause();
    },
  };

  // Aperçus de la barre de position : faits d'images du <video>, que le lecteur natif ne donne pas.
  document.addEventListener('DOMContentLoaded', () => {
    try {
      // eslint-disable-next-line no-undef
      thumbs.has = () => true; // rien n'est dessiné, la barre n'affiche que l'heure
      thumbs.get = () => undefined;
    } catch {}
  });
})();
