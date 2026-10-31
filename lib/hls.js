// Proxy HLS pour le direct et le replay.
//
// Les URL du fournisseur ne sont pas le flux : elles renvoient une redirection 302
// vers un serveur de diffusion avec un jeton temporaire, et la playlist obtenue
// référence ses segments en chemins relatifs vers CE serveur. On suit donc la
// redirection et on réécrit chaque URL de la playlist pour qu'elle repasse par /proxy.

const { Readable } = require('node:stream');
const { fetchUpstream } = require('./xtream');

// Hôtes de diffusion découverts via les redirections : /proxy n'accepte qu'eux.
const allowedOrigins = new Set();
// clé -> URL finale (après redirection), réutilisée aux rafraîchissements de la playlist.
const resolved = new Map();

function proxied(url) {
  return `/proxy?u=${encodeURIComponent(url)}`;
}

// Réécrit chaque URL (lignes de segment et attributs URI="...") pour passer par /proxy.
function rewritePlaylist(text, baseUrl) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(new URL(uri, baseUrl).href)}"`);
      }
      return proxied(new URL(trimmed, baseUrl).href);
    })
    .join('\n');
}

function isPlaylist(upstreamRes) {
  const type = upstreamRes.headers.get('content-type') || '';
  return /mpegurl/i.test(type) || new URL(upstreamRes.url).pathname.endsWith('.m3u8');
}

async function sendPlaylist(res, upstreamRes) {
  const finalUrl = upstreamRes.url;
  allowedOrigins.add(new URL(finalUrl).origin);
  const body = rewritePlaylist(await upstreamRes.text(), finalUrl);
  res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
  res.end(body);
}

// Sert la playlist de `sourceUrl` ; `key` identifie le flux pour réutiliser l'URL résolue.
async function servePlaylist(res, key, sourceUrl) {
  // On réutilise l'URL déjà résolue ; si le jeton a expiré, on refait la redirection.
  const cached = resolved.get(key);
  let upstreamRes = cached ? await fetchUpstream(cached).catch(() => null) : null;
  if (!upstreamRes || !upstreamRes.ok) {
    upstreamRes = await fetchUpstream(sourceUrl);
    if (!upstreamRes.ok) {
      console.warn(`[${key}] HTTP ${upstreamRes.status} depuis le fournisseur`);
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`Fournisseur : HTTP ${upstreamRes.status}`);
    }
    resolved.set(key, upstreamRes.url);
    console.log(`[${key}] -> ${new URL(upstreamRes.url).host}`);
  }
  await sendPlaylist(res, upstreamRes);
}

async function serveProxy(res, target) {
  let url;
  try {
    url = new URL(target);
  } catch {
    res.writeHead(400);
    return res.end('URL invalide');
  }
  if (!allowedOrigins.has(url.origin)) {
    res.writeHead(403);
    return res.end('Hôte non autorisé');
  }

  // Si le lecteur abandonne la requête (changement de chaîne), on coupe aussi en amont.
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  const upstreamRes = await fetchUpstream(url.href, controller.signal);
  if (!upstreamRes.ok) {
    res.writeHead(upstreamRes.status);
    return res.end(`Fournisseur : HTTP ${upstreamRes.status}`);
  }
  if (isPlaylist(upstreamRes)) return sendPlaylist(res, upstreamRes);

  const headers = { 'Content-Type': upstreamRes.headers.get('content-type') || 'video/mp2t' };
  const length = upstreamRes.headers.get('content-length');
  if (length) headers['Content-Length'] = length;
  res.writeHead(200, headers);
  Readable.fromWeb(upstreamRes.body).on('error', () => res.destroy()).pipe(res);
}

module.exports = { servePlaylist, serveProxy };
