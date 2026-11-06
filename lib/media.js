// Films et épisodes : conversion à la volée avec ffmpeg.
//
// Les fichiers du fournisseur (surtout des MKV) ont souvent un son AC3/E-AC3/DTS
// que les navigateurs ne décodent pas, parfois de la vidéo HEVC ou MPEG-4 (AVI).
// ffmpeg les relit en MP4 fragmenté : vidéo copiée telle quelle quand le navigateur
// sait la lire (sinon réencodée en H.264), son toujours réencodé en AAC stéréo.
// Le flux produit n'est pas "seekable" : pour se déplacer, le client relance le
// flux avec un point de départ (start).
//
// Chromium fait démarrer chaque piste de ce MP4 à zéro, quel que soit son horodatage :
// image et son doivent donc commencer au même instant, sinon ils restent décalés.
// Une vidéo copiée ne peut commencer que sur une image clé : le son repart donc de là
// aussi, et le ffmpeg qui produit le flux annonce au passage quelle image clé il a trouvée
// (seekPoint). Une seule ouverture chez le fournisseur par déplacement.
//
// Sous-titres : le même ffmpeg écrit chaque piste de texte du fichier en WebVTT sur une sortie
// à lui (3, 4 …), lue au fur et à mesure ; le lecteur vient chercher les nouveaux sous-titres
// (subtitles). Pas de seconde connexion au fournisseur. Les sous-titres en images (Blu-ray, DVD)
// ne peuvent pas devenir du texte : ils ne sont pas proposés.

const { spawn } = require('node:child_process');
const { USER_AGENT } = require('./xtream');

// Dans l'appli installée, le binaire est extrait de l'archive app.asar pour pouvoir être exécuté.
const FFMPEG = process.env.FFMPEG || require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// Le fournisseur n'autorise qu'une connexion : un seul ffmpeg actif à la fois.
let active = null;
let stopping = Promise.resolve();
// Dernière demande reçue : une demande dépassée pendant qu'elle attendait n'ouvre plus rien.
let turn = 0;
// ffmpeg lancé par seekPoint, en attente du lecteur qui vient chercher le flux.
let prepared = null;
// Sous-titres du flux envoyé en ce moment au lecteur : { url, start, subs }.
let playing = null;

// Arrêt immédiat, sorties comprises : tant qu'il reste dans sa sortie des données que personne
// ne lit (lecteur au tampon plein), Node ne voit jamais ffmpeg se terminer, et tout attendrait derrière lui.
function kill(proc) {
  proc.kill('SIGKILL');
  proc.stdio.forEach((pipe) => pipe?.destroy());
}

function halt() {
  if (active) {
    const { proc, exited } = active;
    active = null;
    kill(proc);
    stopping = exited;
  }
  return stopping;
}

function stopActive() {
  turn++;
  prepared = null;
  return halt();
}

// `outputs` : sorties supplémentaires (3, 4 …), pour les sous-titres.
function run(args, outputs = 0) {
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe', ...Array(outputs).fill('pipe')] });
  const exited = new Promise((resolve) => proc.on('close', resolve));
  active = { proc, exited };
  exited.then(() => {
    if (active?.proc === proc) active = null;
  });
  return { proc, exited };
}

const INPUT_OPTIONS = ['-hide_banner', '-user_agent', USER_AGENT, '-reconnect', '1', '-reconnect_delay_max', '5'];
// Le format est déjà connu (probe) : pas besoin de relire autant de données à chaque ouverture.
const QUICK_OPEN = ['-probesize', '2000000', '-analyzeduration', '1000000'];
// Attente du flux par essai : une ouverture restée sans réponse est relancée, sans QUICK_OPEN.
const OPEN_TIMEOUTS = [10000, 30000];
// Délai laissé au lecteur pour venir chercher le flux préparé.
const PREPARED_TIMEOUT = 15000;

function parseDuration(text) {
  const m = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// Analyse la sortie de `ffmpeg -i` : durée, codec vidéo, pistes audio.
function parseProbe(text) {
  const streams = [];
  for (const line of text.split(/\r?\n/)) {
    const stream = line.match(/Stream #0:\d+(?:\[\w+\])?(?:\((\w+)\))?: (Video|Audio|Subtitle): (\w+)(.*)/);
    if (stream) {
      const [, lang, kind, codec, rest] = stream;
      if (kind === 'Video' && /attached pic/.test(rest)) continue;
      streams.push({ kind, codec, rest, lang: lang || '', channels: (rest.match(/Hz, ([^,]+)/) || [])[1] || '', title: '' });
      continue;
    }
    const title = line.match(/^\s+title\s*:\s*(.+)$/);
    const last = streams[streams.length - 1];
    if (title && last && !last.title) last.title = title[1].trim();
  }
  const video = streams.find((s) => s.kind === 'Video');
  return {
    duration: parseDuration(text),
    origin: Number((text.match(/, start: (-?[\d.]+)/) || [])[1]) || 0,
    video: video ? video.codec : null,
    // Images par seconde : un sous-titre téléchargé n'est calé que s'il a été fait pour la même vitesse.
    fps: Number((video?.rest.match(/, ([\d.]+) fps/) || [])[1]) || null,
    tenBit: /p10(le|be)/.test(video?.rest || ''),
    hdr: /smpte2084|arib-std-b67/.test(video?.rest || ''),
    audio: streams.filter((s) => s.kind === 'Audio').map(({ codec, lang, channels, title }) => ({ codec, lang, channels, title })),
    allSubtitles: streams.filter((s) => s.kind === 'Subtitle').map(({ codec, lang, title }) => ({ codec, lang, title })),
    // `index` : rang parmi toutes les pistes de sous-titres du fichier (pour -map 0:s:N).
    subtitles: streams
      .filter((s) => s.kind === 'Subtitle')
      // « Forcés » (passages en langue étrangère seulement) : souvent indiqué dans le titre seulement.
      .map(({ codec, lang, title, rest }, index) => ({ index, codec, lang, title, forced: /\(forced\)/.test(rest) || /forc/i.test(title) }))
      .filter((s) => TEXT_SUBTITLES.includes(s.codec)),
  };
}

// Sous-titres en texte, convertibles en WebVTT.
const TEXT_SUBTITLES = ['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text'];

// « 01:02:03.456 » ou « 02:03.456 » -> secondes
function vttTime(text) {
  return text.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
}

// Un bloc WebVTT -> { start, end, text } en secondes, ou null (en-tête, note, bloc incomplet).
function vttCue(block) {
  const lines = block.split(/\r?\n/);
  const at = lines.findIndex((line) => line.includes('-->'));
  if (at < 0) return null;
  const [start, end] = lines[at].split('-->').map((part) => vttTime(part.trim().split(/\s/)[0]));
  const text = lines.slice(at + 1).join('\n').trim();
  return text && Number.isFinite(start) && Number.isFinite(end) ? { start, end, text } : null;
}

function parseVtt(text) {
  return text.split(/\r?\n\r?\n/).map(vttCue).filter(Boolean);
}

// Lit le WebVTT de ffmpeg au fil de l'eau : chaque bloc complet devient un sous-titre.
function collectCues(pipe, track) {
  let pending = '';
  const take = (block) => {
    const cue = vttCue(block);
    if (cue) track.cues.push(cue);
  };
  // Prévient le lecteur qui attend (voir subtitles) : ffmpeg ne lit le fichier que quelques
  // secondes avant l'image affichée, un sous-titre doit partir dès qu'il est lu.
  const notify = () => {
    track.waiters.forEach((wake) => wake());
    track.waiters.clear();
  };
  pipe.setEncoding('utf8');
  pipe.on('data', (chunk) => {
    const blocks = (pending + chunk).split(/\r?\n\r?\n/);
    pending = blocks.pop();
    // ffmpeg écrit chaque sous-titre d'un bloc (-flush_packets 1), mais la ligne vide qui le termine
    // n'arrive qu'avec le suivant : attendre celle-ci le retarderait jusqu'au prochain, parfois des minutes.
    if (pending.includes('-->') && /\n$/.test(pending)) {
      blocks.push(pending);
      pending = '';
    }
    blocks.forEach(take);
    notify();
  });
  // 'end' n'arrive pas toujours quand ffmpeg s'arrête : 'close' termine la piste aussi.
  const finish = () => {
    if (track.done) return;
    take(pending);
    pending = '';
    track.done = true;
    notify();
  };
  pipe.on('end', finish);
  pipe.on('close', finish);
}

// Attente maximale d'un nouveau sous-titre avant de répondre quand même (le lecteur redemande aussitôt).
const SUBTITLE_WAIT = 10000;

const probes = new Map();

async function probe(url) {
  if (probes.has(url)) return probes.get(url);
  await halt();
  const { proc, exited } = run([...INPUT_OPTIONS, '-i', url]);
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => kill(proc), 30000);
  await exited;
  clearTimeout(timer);
  const info = parseProbe(stderr);
  if (!info.duration && !info.video) {
    const error = stderr.split(/\r?\n/).filter(Boolean).pop() || 'analyse impossible';
    throw new Error(`ffmpeg : ${error.replace(/https?:\/\/\S+/g, '<url>')}`);
  }
  // Pistes du fichier telles que ffmpeg les voit, pour comprendre un choix de langue inattendu.
  const describe = (s) => [s.lang || '?', s.title && `« ${s.title} »`, s.codec].filter(Boolean).join(' ');
  console.log(`[media] pistes audio : ${info.audio.map(describe).join(', ') || 'aucune'}`);
  console.log(`[media] sous-titres : ${info.allSubtitles.map(describe).join(', ') || 'aucun'}`);
  probes.set(url, info);
  return info;
}

// `codecs` : ce que le lecteur sait décoder, annoncé par le client.
function canCopy(info, codecs) {
  if (info.video === 'h264') return true;
  if (info.video === 'hevc') return codecs.includes(info.tenBit ? 'hevc10' : 'hevc');
  return ['vp9', 'av1'].includes(info.video) && codecs.includes(info.video);
}

// L'encodeur de la carte graphique soulage beaucoup le processeur, s'il y en a un d'utilisable.
let nvenc = null;

async function hasNvenc() {
  nvenc ??= new Promise((resolve) => {
    const proc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:d=0.1', '-c:v', 'h264_nvenc', '-f', 'null', '-'], { stdio: 'ignore' });
    proc.on('error', () => resolve(false));
    proc.on('close', (code) => resolve(code === 0));
  });
  return nvenc;
}

// HDR ramené en SDR quand on réencode, sinon les couleurs sortent délavées.
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,';

async function encodeArgs(info) {
  const filter = `${info.hdr ? TONEMAP : ''}scale='min(1920,iw)':-2,format=yuv420p`;
  // Sans images B, l'image démarre vraiment à zéro, comme le son.
  const encoder = (await hasNvenc())
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-bf', '0']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-bf', '0'];
  return [...encoder, '-vf', filter];
}

// Mixage stéréo : voix plus présente que le mixage par défaut, et pas de caisson.
function audioFilter(track, fromKeyframe) {
  const surround = track && !/^(mono|stereo)$/.test(track.channels) ? ':ochl=stereo:clev=1:slev=0.6:lfe_mix_level=0' : '';
  return `aresample=async=1${fromKeyframe ? '' : ':first_pts=0'}${surround}`;
}

// Lance le ffmpeg du flux. Vidéo copiée en cours de film : image et son repartent de l'image
// clé qui précède `start`, et une seconde sortie écrit celle-ci sur stderr (voir readKeyframe).
// Renvoie null si une demande plus récente est arrivée entre-temps.
async function launch(url, { start, audio, codecs, attempt, mine }) {
  const info = await probe(url);
  const copyVideo = canCopy(info, codecs);
  const fromKeyframe = copyVideo && start > 0;
  const videoArgs = copyVideo
    ? ['-c:v', 'copy', ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : await encodeArgs(info);
  const subtitles = withoutSubtitles.has(url) ? [] : info.subtitles;
  await halt();
  if (mine !== turn) return null;

  const args = [
    ...INPUT_OPTIONS, '-loglevel', 'error',
    ...(attempt === 0 ? QUICK_OPEN : []),
    ...(fromKeyframe ? ['-noaccurate_seek'] : []),
    '-ss', String(start), '-i', url,
    '-map', '0:v:0', '-map', `0:a:${audio}?`,
    ...videoArgs,
    '-af', audioFilter(info.audio[audio], fromKeyframe),
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-map_chapters', '-1',
    ...(fromKeyframe ? ['-avoid_negative_ts', 'make_zero'] : []),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
    ...(fromKeyframe ? ['-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-flush_packets', '1', '-f', 'framecrc', 'pipe:2'] : []),
    // -avoid_negative_ts disabled : un sous-titre déjà commencé au départ décalerait sinon toute la piste.
    ...subtitles.flatMap((s, i) => ['-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-avoid_negative_ts', 'disabled', '-f', 'webvtt', `pipe:${3 + i}`]),
  ];
  console.log(`[media] ${copyVideo ? 'copie' : `réencodage ${videoArgs[1]}`} vidéo ${info.video}, piste audio ${audio}, départ ${Math.round(start)} s${subtitles.length ? `, ${subtitles.length} piste(s) de sous-titres` : ''}${attempt ? `, essai ${attempt + 1}` : ''}`);
  const opening = { ...run(args, subtitles.length), url, audio, stderr: '', videoArgs, startedAt: Date.now() };
  opening.proc.stderr.on('data', (chunk) => (opening.stderr += chunk));
  // Horaires comptés depuis `start` ; `offset` les recale sur le début réel de la vidéo (voir seekPoint).
  opening.subs = { offset: 0, tracks: subtitles.map(() => ({ cues: [], done: false, waiters: new Set() })) };
  opening.subs.tracks.forEach((track, i) => collectCues(opening.proc.stdio[3 + i], track));
  return opening;
}

// Fichiers dont ffmpeg n'a pas su convertir les sous-titres : relus sans.
const withoutSubtitles = new Set();

// ffmpeg arrêté en erreur avant d'avoir rien produit : si des sous-titres étaient demandés, on s'en passe.
function dropSubtitles(opening) {
  if (!opening.subs.tracks.length || opening.proc.killed || withoutSubtitles.has(opening.url)) return false;
  console.warn('[media] sous-titres ignorés pour ce fichier');
  withoutSubtitles.add(opening.url);
  return true;
}

// Position de l'image clé annoncée sur stderr, ou null si ffmpeg s'arrête ou ne répond pas à temps.
function readKeyframe({ proc, exited }, start, timeout) {
  return new Promise((resolve) => {
    let out = '';
    const finish = (value) => {
      clearTimeout(timer);
      proc.stderr.off('data', onData);
      resolve(value);
    };
    const onData = (chunk) => {
      out += chunk;
      const base = out.match(/^#tb 0: (\d+)\/(\d+)/m);
      const frame = out.match(/^0,\s*-?\d+,\s*(-?\d+),/m);
      if (base && frame) finish(Math.max(0, start + Math.min(0, (Number(frame[1]) * Number(base[1])) / Number(base[2]))));
    };
    const timer = setTimeout(() => finish(null), timeout);
    proc.stderr.on('data', onData);
    exited.then(() => finish(null));
  });
}

// Point de départ réel pour `start` : l'image clé qui le précède si la vidéo est copiée.
// Le flux est déjà lancé à ce moment-là : stream() n'a plus qu'à le reprendre.
async function seekPoint(url, start, { audio = 0, codecs = [] }) {
  const mine = ++turn;
  prepared = null;
  const info = await probe(url);
  if (!start || !canCopy(info, codecs)) return start;
  for (let attempt = 0; attempt < OPEN_TIMEOUTS.length; attempt++) {
    const opening = await launch(url, { start, audio, codecs, attempt, mine });
    if (!opening) return start;
    const point = await readKeyframe(opening, start, OPEN_TIMEOUTS[attempt]);
    if (mine !== turn) return start;
    if (point !== null) {
      console.log(`[media] image clé ${point.toFixed(1)} s, trouvée en ${Date.now() - opening.startedAt} ms`);
      // La vidéo commence à l'image clé, avant `start` d'où sont comptés les sous-titres.
      opening.subs.offset = start - point;
      prepared = { ...opening, point };
      setTimeout(() => {
        if (prepared?.proc === opening.proc) stopActive();
      }, PREPARED_TIMEOUT);
      return point;
    }
    // ffmpeg arrêté de lui-même (pas un simple silence du fournisseur) : peut-être les sous-titres.
    if (opening.proc.exitCode !== null && dropSubtitles(opening)) {
      attempt--; // même essai, sans les sous-titres
      continue;
    }
    console.warn(`[media] pas de réponse du fournisseur au bout de ${Date.now() - opening.startedAt} ms`);
    await halt();
  }
  throw Object.assign(new Error('le fournisseur ne répond pas, réessaie dans un instant'), { key: 'providerTimeout' });
}

// Envoie le flux MP4 fragmenté de `url` à partir de `start` secondes (voir seekPoint).
async function stream(res, url, { start = 0, audio = 0, codecs = [] }) {
  const mine = ++turn;
  const ready = prepared;
  prepared = null;
  const request = { url, start, audio, codecs, attempt: 0, mine };
  if (ready?.url === url && ready.audio === audio && ready.point === start && ready.proc.exitCode === null && ready.proc.signalCode === null) {
    return serve(res, ready, request);
  }
  const opening = await launch(url, request);
  if (!opening) return res.destroy();
  serve(res, opening, request);
}

function serve(res, opening, request) {
  const { proc, videoArgs, startedAt } = opening;
  const isCurrent = () => request.mine === turn;
  const killOnClose = () => kill(proc);
  if (res.destroyed) killOnClose();
  res.on('close', killOnClose);
  // ffmpeg arrêté en cours de route (déplacement, autre lecture) : la réponse est coupée aussi,
  // pour libérer la connexion du lecteur (le navigateur n'en ouvre que 6 vers le serveur).
  proc.stdout.once('close', () => {
    if (res.headersSent && !proc.stdout.readableEnded) res.destroy();
  });
  const timer = setTimeout(killOnClose, OPEN_TIMEOUTS[request.attempt]);

  // On attend les premiers octets pour pouvoir encore renvoyer une erreur propre.
  proc.stdout.once('data', (chunk) => {
    clearTimeout(timer);
    console.log(`[media] premiers octets en ${Date.now() - startedAt} ms`);
    playing = { url: request.url, start: request.start, subs: opening.subs };
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    res.write(chunk);
    proc.stdout.pipe(res);
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    const errors = opening.stderr.split(/\r?\n/).filter((line) => line.trim() && !/^(#|\d+,)/.test(line)).join('\n');
    if (errors) console.warn('[media] ffmpeg :', errors.replace(/https?:\/\/\S+/g, '<url>'));
    if (res.headersSent) return;
    res.off('close', killOnClose);
    const again = (attempt) => retry(res, { ...request, attempt });
    if (isCurrent() && !res.destroyed && dropSubtitles(opening)) return again(request.attempt);
    // Carte graphique indisponible pour ce fichier : on repasse au processeur.
    if (videoArgs[1] === 'h264_nvenc' && isCurrent() && !res.destroyed) {
      nvenc = Promise.resolve(false);
      return again(request.attempt);
    }
    if (isCurrent() && !res.destroyed && request.attempt + 1 < OPEN_TIMEOUTS.length) return again(request.attempt + 1);
    if (res.destroyed) return;
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`ffmpeg s'est arrêté (code ${code})`);
  });
}

async function retry(res, request) {
  try {
    const opening = await launch(request.url, request);
    if (!opening) return res.destroy();
    serve(res, opening, request);
  } catch (err) {
    res.destroy(err);
  }
}

// Sous-titres de la piste `track` (rang parmi probe().subtitles) reçus depuis le n° `from`,
// en temps de la vidéo envoyée. Sans nouveauté, la réponse attend le prochain (au plus SUBTITLE_WAIT).
// `ready` faux tant que ce flux-là n'a pas commencé.
async function subtitles(url, start, track, from = 0) {
  if (playing?.url !== url || playing.start !== start || !playing.subs.tracks[track]) return { ready: false, cues: [], done: false };
  const { offset, tracks } = playing.subs;
  const feed = tracks[track];
  if (feed.cues.length <= from && !feed.done) {
    await new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        feed.waiters.delete(wake);
        resolve();
      }, SUBTITLE_WAIT);
      feed.waiters.add(wake);
    });
  }
  return {
    ready: true,
    done: feed.done,
    cues: feed.cues.slice(from).map((c) => ({ start: c.start + offset, end: c.end + offset, text: c.text })),
  };
}

module.exports = { probe, seekPoint, stream, stopActive, subtitles, parseVtt };
