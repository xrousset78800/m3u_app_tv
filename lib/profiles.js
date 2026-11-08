// Comptes de l'appli : un administrateur (le premier, sans mot de passe au départ) et des comptes
// limités à certains groupes, pour un enfant ou par thème. Le compte choisi est retenu par un cookie
// de session, valable jusqu'à la fermeture de l'appli : l'écran de choix revient à chaque lancement.

const crypto = require('node:crypto');
const db = require('./db');

const ROLES = ['admin', 'standard', 'child'];
const TYPES = ['live', 'vod', 'series'];
const COOKIE = 'tv_profile';

const sessions = new Map(); // jeton → { id, episodes }

const fail = (status, key) => Object.assign(new Error(key), { status, key });

function hash(password) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(password, salt, 32).toString('hex')}`;
}

function verify(password, stored) {
  const [salt, expected] = stored.split(':').map((part) => Buffer.from(part, 'hex'));
  return crypto.timingSafeEqual(crypto.scryptSync(String(password), salt, 32), expected);
}

// Ce que voit l'écran de choix : jamais le mot de passe, seulement s'il y en a un.
const summary = ({ id, name, role, password, groups }) => ({ id, name, role, locked: Boolean(password), groups });

const list = () => db.profiles.all().map(summary);

// Compte de la requête, d'après le cookie ; null sans session (ou compte supprimé entre-temps).
function fromRequest(req) {
  const token = /(?:^|;\s*)tv_profile=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];
  const session = token && sessions.get(token);
  const profile = session && db.profiles.get(session.id);
  if (!profile) return null;
  return { ...summary(profile), session, token };
}

// Session ouverte : le cookie à renvoyer.
function open(profile) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { id: profile.id, episodes: new Set() });
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

async function select(id, password) {
  const profile = db.profiles.get(id);
  if (!profile) throw fail(404, 'profileMissing');
  if (profile.password && !verify(password ?? '', profile.password)) {
    await new Promise((resolve) => setTimeout(resolve, 600)); // pas d'essais en rafale
    throw fail(403, 'wrongPassword');
  }
  return open(profile);
}

function close(req) {
  const token = /(?:^|;\s*)tv_profile=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];
  if (token) sessions.delete(token);
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// Un seul compte, sans mot de passe : on y entre directement.
function automatic() {
  const all = db.profiles.all();
  return all.length === 1 && !all[0].password ? all[0] : null;
}

// Groupes autorisés : par type, des identifiants de groupe ; null pour un compte qui voit tout.
function cleanGroups(groups) {
  if (groups == null) return null;
  if (typeof groups !== 'object') throw fail(400, 'invalidProfile');
  return Object.fromEntries(TYPES.map((type) => {
    const ids = groups[type] ?? [];
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) throw fail(400, 'invalidProfile');
    return [type, [...new Set(ids)]];
  }));
}

// `password` : absent, on garde l'actuel ; '' l'enlève ; sinon le nouveau.
function clean(input, current) {
  const name = String(input.name ?? current?.name ?? '').trim().slice(0, 40);
  const role = input.role ?? current?.role;
  if (!name || !ROLES.includes(role)) throw fail(400, 'invalidProfile');
  let password = current?.password ?? null;
  if (typeof input.password === 'string') password = input.password ? hash(input.password) : null;
  // Un administrateur voit tout ; les groupes ne concernent que les autres comptes.
  const groups = role === 'admin' ? null : cleanGroups('groups' in input ? input.groups : current?.groups ?? (role === 'child' ? {} : null));
  return { name, role, password, groups };
}

const admins = () => db.profiles.all().filter((p) => p.role === 'admin');

function create(input) {
  return db.profiles.create(clean(input));
}

function update(id, input) {
  const current = db.profiles.get(id);
  if (!current) throw fail(404, 'profileMissing');
  const next = clean(input, current);
  if (current.role === 'admin' && next.role !== 'admin' && admins().length === 1) throw fail(409, 'lastAdmin');
  db.profiles.update(current.id, next);
}

function remove(id, self) {
  const current = db.profiles.get(id);
  if (!current) throw fail(404, 'profileMissing');
  if (current.id === self) throw fail(409, 'deleteSelf');
  if (current.role === 'admin' && admins().length === 1) throw fail(409, 'lastAdmin');
  db.profiles.remove(current.id);
  for (const [token, session] of sessions) if (session.id === current.id) sessions.delete(token);
}

// Restauration d'une sauvegarde : comptes vérifiés un à un, au moins un administrateur ;
// toutes les sessions sont fermées, chacun choisit à nouveau son compte.
function restore(input) {
  const list = Array.isArray(input) ? input : [];
  const seen = new Set();
  const restored = list.map((p) => {
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) throw fail(400, 'badBackup');
    seen.add(id);
    const { name, role, groups } = clean({ ...p, password: undefined });
    const password = p.password ?? null;
    if (password !== null && !/^[0-9a-f]{32}:[0-9a-f]{64}$/.test(password)) throw fail(400, 'badBackup');
    return { id, name, role, password, groups };
  });
  if (!restored.some((p) => p.role === 'admin')) throw fail(400, 'badBackup');
  sessions.clear();
  return restored;
}

module.exports = { restore, list, fromRequest, select, open, close, automatic, create, update, remove };
