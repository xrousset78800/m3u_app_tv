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
//
// Ce que ffmpeg produit est aussi gardé dans un fichier temporaire (spool) : quand le lecteur
// de Chromium perd sa connexion et redemande le même flux, il le reprend de ce fichier, sans
// relancer ffmpeg chez le fournisseur ni tout retélécharger depuis le début.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
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
  dropSpool();
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

// Connexion instable : ffmpeg se reconnecte de lui-même, au même endroit du fichier, quand le fournisseur coupe,
// quand le réseau lâche, ou quand il refuse un instant (le temps de libérer l'unique connexion de l'abonnement).
// Essais espacés de 1, 3, 7 puis 15 s. Une connexion restée muette 20 s compte comme coupée.
const INPUT_OPTIONS = [
  '-hide_banner', '-user_agent', USER_AGENT,
  '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1',
  '-reconnect_on_http_error', '403,429,5xx', '-reconnect_delay_max', '20',
  '-rw_timeout', '20000000',
];
// Le format est déjà connu (probe) : pas besoin de relire autant de données à chaque ouverture.
const QUICK_OPEN = ['-probesize', '2000000', '-analyzeduration', '1000000'];
// Attente du flux par essai : une ouverture restée sans réponse est relancée, sans QUICK_OPEN.
const OPEN_TIMEOUTS = [10000, 30000];
// Délai laissé au lecteur pour venir chercher le flux préparé.
const PREPARED_TIMEOUT = 15000;

// --- Spool : le flux du film en cours, gardé sur disque pendant la lecture ---
const SPOOL_DIR = os.tmpdir();
const SPOOL_PREFIX = 'tv-flux-';
// Avance maximale de ffmpeg sur le lecteur : au-delà, on cesse de lire le fournisseur.
const SPOOL_AHEAD = 256 * 1024 ** 2;
// Taille maximale du fichier (et 2 Go laissés libres sur le disque) : au-delà, envoi direct comme avant.
const SPOOL_MAX = 8 * 1024 ** 3;
// Lecteur parti sans revenir : ffmpeg est arrêté, pour libérer la connexion au fournisseur.
const SPOOL_IDLE = 5 * 60 * 1000;
const READ_CHUNK = 1024 * 1024;
let spool = null;
const mb = (bytes) => `${Math.round(bytes / 1024 ** 2)} Mo`;

// Fichiers laissés par une appli arrêtée net.
try {
  for (const name of fs.readdirSync(SPOOL_DIR)) {
    if (!name.startsWith(SPOOL_PREFIX)) continue;
    const file = path.join(SPOOL_DIR, name);
    if (Date.now() - fs.statSync(file).mtimeMs > 6 * 3600 * 1000) fs.rmSync(file, { force: true });
  }
} catch {}
process.on('exit', () => {
  if (spool) try { fs.rmSync(spool.file, { force: true }); } catch {}
});

function spoolLimit() {
  try {
    const { bavail, bsize } = fs.statfsSync(SPOOL_DIR);
    return Math.min(SPOOL_MAX, bavail * bsize - 2 * 1024 ** 3);
  } catch {
    return SPOOL_MAX;
  }
}

function wake(s) {
  const waiters = [...s.waiters];
  s.waiters.clear();
  waiters.forEach((resolve) => resolve());
}

function dropSpool() {
  const s = spool;
  if (!s) return;
  spool = null;
  s.dead = true;
  clearTimeout(s.idle);
  s.readers.forEach((res) => res.destroy());
  wake(s);
  try { fs.closeSync(s.fd); } catch {}
  fs.rm(s.file, { force: true }, () => {});
}

// Lecture de ffmpeg mise en pause tant qu'il a trop d'avance sur le lecteur.
function flow(s) {
  if (s.dead || s.full) return;
  const { stdout } = s.proc;
  if (s.size - s.reached > SPOOL_AHEAD) stdout.pause();
  else if (stdout.isPaused()) stdout.resume();
}

function startSpool(opening, request, first) {
  dropSpool();
  const file = path.join(SPOOL_DIR, `${SPOOL_PREFIX}${process.pid}.mp4`);
  const s = {
    url: request.url, start: request.start, audio: request.audio, file, fd: fs.openSync(file, 'w+'),
    limit: spoolLimit(), size: 0, reached: 0, done: false, failed: false, full: false, direct: false, dead: false,
    proc: opening.proc, subs: opening.subs, readers: new Set(), waiters: new Set(), idle: null,
  };
  spool = s;
  const { stdout } = opening.proc;
  const append = (chunk) => {
    if (s.dead) return;
    fs.writeSync(s.fd, chunk, 0, chunk.length, s.size);
    s.size += chunk.length;
    if (s.size >= s.limit) {
      // Fichier plein : le lecteur finira de le lire, puis recevra la suite directement de ffmpeg.
      console.warn(`[media] fichier tampon plein (${mb(s.size)}) : la suite part directement au lecteur`);
      s.full = true;
      stdout.off('data', append);
      stdout.pause();
    }
    flow(s);
    wake(s);
  };
  append(first);
  stdout.on('data', append);
  stdout.once('end', () => {
    s.done = true;
    wake(s);
  });
  stdout.once('close', () => {
    if (!s.done) s.failed = true;
    wake(s);
  });
  return s;
}

const untilDrained = (res) => new Promise((resolve) => {
  const done = () => {
    res.off('drain', done);
    res.off('close', done);
    resolve();
  };
  res.on('drain', done);
  res.on('close', done);
});

// Envoie au lecteur le flux gardé dans `s`, depuis le début, puis la suite à mesure que ffmpeg la produit.
async function feed(res, s) {
  const handle = await fsp.open(s.file, 'r').catch(() => null);
  if (!handle || s.dead) {
    handle?.close();
    return res.destroy();
  }
  s.readers.add(res);
  clearTimeout(s.idle);
  let pos = 0;
  const openedAt = Date.now();
  res.on('close', () => {
    s.readers.delete(res);
    wake(s);
    if (s.dead || s.done) return;
    console.log(`[media] lecteur déconnecté après ${Math.round((Date.now() - openedAt) / 1000)} s, à ${mb(pos)} sur ${mb(s.size)} prêts`);
    if (s.direct) return kill(s.proc);
    if (s.readers.size) return;
    s.idle = setTimeout(() => {
      if (spool !== s || s.readers.size) return;
      console.log('[media] lecteur parti : flux arrêté');
      stopActive();
    }, SPOOL_IDLE);
  });
  try {
    while (!res.destroyed && !s.dead) {
      if (pos < s.size) {
        const length = Math.min(s.size - pos, READ_CHUNK);
        const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(length), 0, length, pos);
        if (!bytesRead || res.destroyed) break;
        pos += bytesRead;
        s.reached = Math.max(s.reached, pos);
        flow(s);
        if (!res.write(buffer.subarray(0, bytesRead))) await untilDrained(res);
      } else if (s.full && !s.direct) {
        s.direct = true;
        s.proc.stdout.pipe(res);
        return;
      } else if (s.done) {
        return res.end();
      } else if (s.failed || s.full) {
        break;
      } else {
        await new Promise((resolve) => s.waiters.add(resolve));
      }
    }
    res.destroy();
  } catch {
    res.destroy();
  } finally {
    handle.close().catch(() => {});
  }
}

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
    // Dolby Vision : profil 5 sans image HDR10 de repli, les couleurs sortent fausses (vert, violet).
    dolbyVision: Number((text.match(/DOVI configuration record:.*?profile: (\d+)/) || [])[1]) || null,
    size: (video?.rest.match(/, (\d{3,5}x\d{3,5})/) || [])[1] || '',
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
  // Image réduite avant le passage en SDR : en 4K, ce calcul en virgule flottante ne suivait pas le film.
  const filter = `scale='min(1920,iw)':-2,${info.hdr ? TONEMAP : ''}format=yuv420p`;
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
// `live` : chaîne en direct (flux sans fin), prise où elle en est.
async function launch(url, { start, audio, codecs, attempt, mine, live = false }) {
  const info = await probe(url);
  const copyVideo = canCopy(info, codecs);
  const fromKeyframe = copyVideo && start > 0;
  // Direct : l'image et le son ne commencent pas au même instant, on cale le tout sur zéro sans rien couper.
  const shifted = fromKeyframe || live;
  const videoArgs = copyVideo
    ? ['-c:v', 'copy', ...(info.video === 'hevc' ? ['-tag:v', 'hvc1'] : [])]
    : await encodeArgs(info);
  const subtitles = live || withoutSubtitles.has(url) ? [] : info.subtitles;
  await halt();
  if (mine !== turn) return null;

  const args = [
    // Avertissements compris, pour voir passer les reconnexions (voir watchErrors).
    ...INPUT_OPTIONS, '-loglevel', 'level+warning',
    ...(attempt === 0 ? QUICK_OPEN : []),
    ...(fromKeyframe ? ['-noaccurate_seek'] : []),
    ...(live ? [] : ['-ss', String(start)]), '-i', url,
    '-map', '0:v:0', '-map', `0:a:${audio}?`,
    ...videoArgs,
    '-af', audioFilter(info.audio[audio], shifted),
    '-c:a', 'aac', '-ac', '2', '-b:a', '192k',
    '-map_chapters', '-1',
    ...(shifted ? ['-avoid_negative_ts', 'make_zero'] : []),
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    // Direct : envoyé chaque seconde, sans attendre l'image clé suivante (parfois 10 s plus loin).
    ...(live ? ['-frag_duration', '1000000'] : []),
    'pipe:1',
    ...(fromKeyframe ? ['-map', '0:v:0', '-c', 'copy', '-frames:v', '1', '-flush_packets', '1', '-f', 'framecrc', 'pipe:2'] : []),
    // -avoid_negative_ts disabled : un sous-titre déjà commencé au départ décalerait sinon toute la piste.
    ...subtitles.flatMap((s, i) => ['-map', `0:s:${s.index}`, '-c:s', 'webvtt', '-flush_packets', '1', '-avoid_negative_ts', 'disabled', '-f', 'webvtt', `pipe:${3 + i}`]),
  ];
  const kind = [info.video, info.size, info.tenBit && '10 bits', info.hdr && 'HDR', info.dolbyVision && `Dolby Vision ${info.dolbyVision}`].filter(Boolean).join(' ');
  console.log(`[media] ${copyVideo ? 'copie' : `réencodage ${videoArgs[1]}`} vidéo ${kind}, piste audio ${audio}, ${live ? 'direct' : `départ ${Math.round(start)} s`}${subtitles.length ? `, ${subtitles.length} piste(s) de sous-titres` : ''}${attempt ? `, essai ${attempt + 1}` : ''}`);
  const opening = { ...run(args, subtitles.length), url, audio, stderr: '', videoArgs, startedAt: Date.now() };
  watchErrors(opening);
  // Horaires comptés depuis `start` ; `offset` les recale sur le début réel de la vidéo (voir seekPoint).
  opening.subs = { offset: 0, tracks: subtitles.map(() => ({ cues: [], done: false, waiters: new Set() })) };
  opening.subs.tracks.forEach((track, i) => collectCues(opening.proc.stdio[3 + i], track));
  return opening;
}

// Messages de ffmpeg : les reconnexions au fournisseur vont au journal sur le moment ; les erreurs sont gardées
// pour être données à l'arrêt. Le reste des avertissements (horodatages bancals du fichier…) est ignoré.
function watchErrors(opening) {
  let pending = '';
  opening.proc.stderr.on('data', (chunk) => {
    const lines = (pending + chunk).split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) {
      if (/Will reconnect|reconnect/i.test(line) && /\[(warning|error)\]/.test(line)) {
        console.warn(`[media] reconnexion au fournisseur : ${line.replace(/^.*\] /, '')}`);
      } else if (/\[(error|fatal|panic)\]/.test(line)) {
        if (opening.stderr.length < 20000) opening.stderr += `${line.replace(/\[(error|fatal|panic)\] /, '')}\n`;
      }
    }
  });
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
async function stream(res, url, { start = 0, audio = 0, codecs = [], live = false, range }) {
  // Le lecteur redemande le flux qu'il lisait déjà (connexion perdue) : repris du fichier tampon.
  const s = spool;
  if (!live && s && !s.dead && !s.failed && !s.full && s.url === url && s.start === start && s.audio === audio) {
    console.log(`[media] le lecteur redemande le flux${range ? ` (${range})` : ''} : repris du fichier tampon (${mb(s.size)})`);
    playing = { url, start, subs: s.subs };
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    return feed(res, s);
  }
  if (range && range !== 'bytes=0-') console.log(`[media] demande du lecteur avec ${range}`);
  const mine = ++turn;
  const ready = prepared;
  prepared = null;
  const request = { url, start, audio, codecs, attempt: 0, mine, live };
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
  const timer = setTimeout(killOnClose, OPEN_TIMEOUTS[request.attempt]);

  // On attend les premiers octets pour pouvoir encore renvoyer une erreur propre.
  proc.stdout.once('data', (chunk) => {
    clearTimeout(timer);
    console.log(`[media] premiers octets en ${Date.now() - startedAt} ms`);
    playing = { url: request.url, start: request.start, subs: opening.subs };
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Cache-Control': 'no-store' });
    if (request.live) {
      // ffmpeg arrêté en cours de route (autre lecture) : la réponse est coupée aussi,
      // pour libérer la connexion du lecteur (le navigateur n'en ouvre que 6 vers le serveur).
      proc.stdout.once('close', () => {
        if (!proc.stdout.readableEnded) res.destroy();
      });
      res.write(chunk);
      proc.stdout.pipe(res);
      return;
    }
    // Film : le flux passe par le fichier tampon, ffmpeg survit à une connexion perdue du lecteur.
    res.off('close', killOnClose);
    feed(res, startSpool(opening, request, chunk));
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    // Sortie lue jusqu'au bout : ffmpeg s'est arrêté de lui-même (fin du film, ou fournisseur perdu pour de bon).
    if (res.headersSent && proc.stdout.readableEnded) console.log(`[media] flux terminé par ffmpeg (code ${code}) après ${Math.round((Date.now() - startedAt) / 1000)} s`);
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
