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
// Une vidéo copiée ne peut commencer que sur une image clé : on repart de celle-ci
// (seekPoint), et le son est complété pour démarrer pile avec elle.

const { spawn } = require('node:child_process');
const { USER_AGENT } = require('./xtream');

// Dans l'appli installée, le binaire est extrait de l'archive app.asar pour pouvoir être exécuté.
const FFMPEG = process.env.FFMPEG || require('ffmpeg-static').replace('app.asar', 'app.asar.unpacked');

// Le fournisseur n'autorise qu'une connexion : un seul ffmpeg actif à la fois.
let active = null;

async function stopActive() {
  if (!active) return;
  const { proc, exited } = active;
  active = null;
  proc.kill('SIGKILL');
  await exited;
}

function run(args) {
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => proc.on('close', resolve));
  active = { proc, exited };
  exited.then(() => {
    if (active?.proc === proc) active = null;
  });
  return { proc, exited };
}

const INPUT_OPTIONS = ['-hide_banner', '-user_agent', USER_AGENT, '-reconnect', '1', '-reconnect_delay_max', '5'];

function parseDuration(text) {
  const m = text.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

// Analyse la sortie de `ffmpeg -i` : durée, codec vidéo, pistes audio.
function parseProbe(text) {
  const streams = [];
  for (const line of text.split(/\r?\n/)) {
    const stream = line.match(/Stream #0:\d+(?:\[\w+\])?(?:\((\w+)\))?: (Video|Audio): (\w+)(.*)/);
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
    tenBit: /p10(le|be)/.test(video?.rest || ''),
    hdr: /smpte2084|arib-std-b67/.test(video?.rest || ''),
    audio: streams.filter((s) => s.kind === 'Audio').map(({ codec, lang, channels, title }) => ({ codec, lang, channels, title })),
  };
}

const probes = new Map();

async function probe(url) {
  if (probes.has(url)) return probes.get(url);
  await stopActive();
  const { proc, exited } = run([...INPUT_OPTIONS, '-i', url]);
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
  await exited;
  clearTimeout(timer);
  const info = parseProbe(stderr);
  if (!info.duration && !info.video) {
    const error = stderr.split(/\r?\n/).filter(Boolean).pop() || 'analyse impossible';
    throw new Error(`ffmpeg : ${error.replace(/https?:\/\/\S+/g, '<url>')}`);
  }
  probes.set(url, info);
  return info;
}

// `codecs` : ce que le lecteur sait décoder, annoncé par le client.
function canCopy(info, codecs) {
  if (info.video === 'h264') return true;
  if (info.video === 'hevc') return codecs.includes(info.tenBit ? 'hevc10' : 'hevc');
  return ['vp9', 'av1'].includes(info.video) && codecs.includes(info.video);
}

// Point de départ réel pour `start` : l'image clé qui le précède si la vidéo est copiée.
async function seekPoint(url, start, codecs) {
  const info = await probe(url);
  if (!start || !canCopy(info, codecs)) return start;
  await stopActive();
  const { proc, exited } = run([
    ...INPUT_OPTIONS, '-loglevel', 'error', '-copyts', '-ss', String(start), '-i', url,
    '-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-f', 'framecrc', 'pipe:1',
  ]);
  let out = '';
  proc.stdout.on('data', (chunk) => (out += chunk));
  proc.stderr.resume();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 30000);
  await exited;
  clearTimeout(timer);
  const base = out.match(/^#tb 0: (\d+)\/(\d+)/m);
  const frame = out.match(/^0,\s*-?\d+,\s*(-?\d+),/m);
  if (!base || !frame) return start;
  const keyframe = (Number(frame[1]) * Number(base[1])) / Number(base[2]) - info.origin;
  return Math.max(0, Math.min(start, keyframe));
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
function audioFilter(track) {
  const surround = track && !/^(mono|stereo)$/.test(track.channels) ? ':ochl=stereo:clev=1:slev=0.6:lfe_mix_level=0' : '';
  return `aresample=async=1:first_pts=0${surround}`;
}

// Envoie le flux MP4 fragmenté de `url` à partir de `start` secondes (voir seekPoint).
async function stream(res, url, { start = 0, audio = 0, codecs = [] }) {
  const info = await probe(url);
  await stopActive();

  const copyVideo = canCopy(info, codecs);
  const videoArgs = copyVideo
    ? ['-c:v', 'copy', ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : await encodeArgs(info);

  const args = [
    ...INPUT_OPTIONS, '-loglevel', 'error',
    '-ss', String(start), '-i', url,
    '-map', '0:v:0', '-map', `0:a:${audio}?`,
    ...videoArgs,
    '-af', audioFilter(info.audio[audio]),
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-map_chapters', '-1',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
  console.log(`[media] ${copyVideo ? 'copie' : `réencodage ${videoArgs[1]}`} vidéo ${info.video}, piste audio ${audio}, départ ${Math.round(start)} s`);

  const { proc } = run(args);
  let stderr = '';
  proc.stderr.on('data', (chunk) => (stderr += chunk));
  res.on('close', () => proc.kill('SIGKILL'));

  // On attend les premiers octets pour pouvoir encore renvoyer une erreur propre.
  proc.stdout.once('data', (chunk) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    res.write(chunk);
    proc.stdout.pipe(res);
  });
  proc.on('close', (code) => {
    if (stderr.trim()) console.warn('[media] ffmpeg :', stderr.trim().replace(/https?:\/\/\S+/g, '<url>'));
    // Carte graphique indisponible pour ce fichier : on repasse au processeur.
    if (!res.headersSent && videoArgs[1] === 'h264_nvenc' && !res.destroyed) {
      nvenc = Promise.resolve(false);
      stream(res, url, { start, audio, codecs }).catch((err) => res.destroy(err));
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`ffmpeg s'est arrêté (code ${code})`);
    }
  });
}

module.exports = { probe, seekPoint, stream, stopActive };
