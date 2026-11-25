import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'pd_sid';
const sessions = new Map(); // token -> { user, expires }
const salt = crypto.randomBytes(16);
const adminHash = crypto.scryptSync(config.adminPassword, salt, 64);
const adminUserHash = crypto.createHash('sha256').update(config.adminUser).digest();

// Anti-bruteforce : 10 échecs max par IP sur 15 minutes.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 10;

export function isRateLimited(ip) {
  const f = failures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) { failures.delete(ip); return false; }
  return f.count >= MAX_FAILURES;
}

function recordFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first > WINDOW) failures.set(ip, { count: 1, first: Date.now() });
  else f.count++;
}

export function checkCredentials(user, password, ip) {
  const userOk = crypto.timingSafeEqual(crypto.createHash('sha256').update(String(user)).digest(), adminUserHash);
  const passOk = crypto.timingSafeEqual(crypto.scryptSync(String(password), salt, 64), adminHash);
  if (userOk && passOk) { failures.delete(ip); return true; }
  recordFailure(ip);
  return false;
}

export function createSession(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { user, expires: Date.now() + config.sessionHours * 3600 * 1000 });
  return token;
}

export function destroySession(token) { sessions.delete(token); }

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

export function sessionFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return { token, ...s };
}

export function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'strict', secure: config.cookieSecure, path: '/',
    maxAge: config.sessionHours * 3600 * 1000,
  });
}

export function clearSessionCookie(res) { res.clearCookie(COOKIE, { path: '/' }); }

export function requireAuth(req, res, next) {
  const s = sessionFromCookieHeader(req.headers.cookie);
  if (!s) return res.status(401).json({ error: 'Non authentifié' });
  req.session = s;
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 10 * 60 * 1000).unref();
