// Films et épisodes : conversion à la volée avec ffmpeg.
//
// Les fichiers du fournisseur (surtout des MKV) ont souvent un son AC3/E-AC3/DTS
// que les navigateurs ne décodent pas, parfois de la vidéo HEVC ou MPEG-4 (AVI).
// ffmpeg les relit en MP4 fragmenté : vidéo copiée telle quelle quand le navigateur
// sait la lire (sinon réencodée en H.264), son toujours réencodé en AAC stéréo.
// Le flux produit n'est pas "seekable" : pour se déplacer, le client relance le
// flux avec un point de départ (start).

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
      streams.push({ kind, codec, lang: lang || '', channels: (rest.match(/Hz, ([^,]+)/) || [])[1] || '', title: '' });
      continue;
    }
    const title = line.match(/^\s+title\s*:\s*(.+)$/);
    const last = streams[streams.length - 1];
    if (title && last && !last.title) last.title = title[1].trim();
  }
  const video = streams.find((s) => s.kind === 'Video');
  return {
    duration: parseDuration(text),
    video: video ? video.codec : null,
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

// Envoie le flux MP4 fragmenté de `url` à partir de `start` secondes.
async function stream(res, url, { start = 0, audio = 0, hevc = false }) {
  const info = await probe(url);
  await stopActive();

  const copyVideo = info.video === 'h264' || (info.video === 'hevc' && hevc);
  const videoArgs = copyVideo
    ? ['-c:v', 'copy', ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p', '-vf', "scale='min(1920,iw)':-2"];

  const args = [
    ...INPUT_OPTIONS, '-loglevel', 'error',
    '-ss', String(start), '-i', url,
    '-map', '0:v:0', '-map', `0:a:${audio}?`,
    ...videoArgs,
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-map_chapters', '-1',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1',
  ];
  console.log(`[media] ${copyVideo ? 'copie' : 'réencodage'} vidéo ${info.video}, piste audio ${audio}, départ ${Math.round(start)} s`);

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
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`ffmpeg s'est arrêté (code ${code})`);
    }
  });
}

module.exports = { probe, stream, stopActive };
