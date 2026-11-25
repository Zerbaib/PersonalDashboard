import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import {
  listServices, getService, createService, updateService, deleteService, lastCheck, getHistory, getUptimes, PERIODS,
} from './db.js';
import { encrypt, decrypt } from './crypto.js';
import {
  checkCredentials, createSession, destroySession, setSessionCookie, clearSessionCookie,
  requireAuth, sessionFromCookieHeader, isRateLimited,
} from './auth.js';
import { startMonitor, checkNow } from './monitor.js';
import { attachTerminal } from './terminal.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
  });
  next();
});
app.use(express.json({ limit: '32kb' }));

// ---------- Fichiers statiques ----------
const nm = (p) => path.join(root, 'node_modules', p);
app.use('/vendor/chart.js', express.static(nm('chart.js/dist')));
app.use('/vendor/xterm', express.static(nm('@xterm/xterm')));
app.use('/vendor/xterm-fit', express.static(nm('@xterm/addon-fit/lib')));
app.get('/admin', (req, res) => res.sendFile(path.join(root, 'public', 'admin.html')));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));

// ---------- Helpers ----------
const hoursOf = (req) => (PERIODS[req.query.hours] ? Number(req.query.hours) : 24);

function statusOf(s, hours) {
  const last = lastCheck(s.id);
  const { uptime, history } = getHistory(s.id, hours);
  return {
    up: last ? !!last.up : null,
    latency: last?.latency_ms != null ? Math.round(last.latency_ms) : null,
    checked_at: last?.ts ?? null,
    message: last?.message ?? null,
    uptime: uptime != null ? Math.round(uptime * 10000) / 100 : null,
    ...getUptimes(s.id),
    history,
  };
}

function publicView(s, hours) {
  const { message, ...status } = statusOf(s, hours); // pas de message (peut révéler des IP)
  return { id: s.id, name: s.name, type: s.type, link_url: s.link_url, ...status };
}

function adminView(s, hours) {
  const { ssh_password_enc, ...rest } = s;
  return { ...rest, is_public: !!s.is_public, has_password: !!ssh_password_enc, ...statusOf(s, hours) };
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => { throw new HttpError(400, msg); };

const str = (v, max = 255) => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') bad('Valeur texte attendue');
  const t = v.trim();
  if (t.length > max) bad(`Valeur trop longue (max ${max})`);
  return t || null;
};
const int = (v, min, max, def) => {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`Nombre entre ${min} et ${max} attendu`);
  return n;
};
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-:]*[a-zA-Z0-9])?$/;
const DOMAIN_RE = /^(?=.{1,253}\.?$)([a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9_]([a-zA-Z0-9_-]{0,61}[a-zA-Z0-9])?\.?$/;
const isUrl = (u) => { try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; } };

function validate(body, existing) {
  const s = {
    name: str(body.name, 100) ?? bad('Nom requis'),
    type: body.type,
    target: str(body.target, 500) ?? bad('Cible requise'),
    port: int(body.port, 1, 65535, null),
    dns_query: str(body.dns_query, 253),
    dns_record_type: str(body.dns_record_type, 10)?.toUpperCase() ?? null,
    link_url: str(body.link_url, 500),
    interval_sec: int(body.interval_sec, 10, 86400, 60),
    is_public: body.is_public === false || body.is_public === 0 ? 0 : 1,
    position: int(body.position, 0, 100000, existing?.position ?? 0),
    ip: str(body.ip, 255),
    ssh_port: int(body.ssh_port, 1, 65535, 22),
    ssh_user: str(body.ssh_user, 100) ?? 'root',
  };
  if (!['ping', 'tcp', 'http', 'dns'].includes(s.type)) bad('Type invalide (ping, tcp, http, dns)');
  if (s.type === 'http' && !isUrl(s.target)) bad('La cible HTTP doit être une URL http(s)://');
  if (['ping', 'tcp', 'dns'].includes(s.type) && !HOST_RE.test(s.target)) bad('Nom d’hôte / IP invalide');
  if (s.type === 'tcp' && !s.port) bad('Port requis pour une vérification TCP');
  if (s.type === 'dns') {
    s.port ??= 53;
    s.dns_query ??= 'example.com';
    s.dns_record_type ??= 'A';
    if (s.dns_query !== '.' && !DOMAIN_RE.test(s.dns_query)) bad('Domaine de test invalide');
    if (!['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'CAA'].includes(s.dns_record_type)) bad('Type d’enregistrement DNS invalide');
  } else {
    s.dns_query = null;
    s.dns_record_type = null;
  }
  if (s.link_url && !isUrl(s.link_url)) bad('Le lien doit être une URL http(s)://');
  if (s.ip && !HOST_RE.test(s.ip)) bad('IP / hôte SSH invalide');

  // Mot de passe : vide = conserver, clear_password = supprimer
  if (body.clear_password) s.ssh_password_enc = null;
  else if (typeof body.ssh_password === 'string' && body.ssh_password !== '') {
    if (body.ssh_password.length > 500) bad('Mot de passe trop long');
    s.ssh_password_enc = encrypt(body.ssh_password);
  } else if (!existing) s.ssh_password_enc = null;

  // Hôte SSH modifié ou demande explicite -> on oublie l'empreinte mémorisée
  if (existing && (body.reset_fingerprint || existing.ip !== s.ip || existing.ssh_port !== s.ssh_port)) {
    s.ssh_fingerprint = null;
  }
  return s;
}

const serviceOr404 = (req) => getService(Number(req.params.id)) ?? (() => { throw new HttpError(404, 'Service introuvable'); })();

// ---------- API publique ----------
app.get('/api/status', (req, res) => {
  const hours = hoursOf(req);
  res.json(listServices().filter((s) => s.is_public).map((s) => publicView(s, hours)));
});

// ---------- Authentification ----------
app.post('/api/login', (req, res) => {
  if (isRateLimited(req.ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const { username, password } = req.body ?? {};
  if (!checkCredentials(username ?? '', password ?? '', req.ip)) {
    console.warn(`[auth] Échec de connexion depuis ${req.ip}`);
    return res.status(401).json({ error: 'Identifiants invalides' });
  }
  setSessionCookie(res, createSession(username));
  res.json({ user: username });
});

app.post('/api/logout', (req, res) => {
  const s = sessionFromCookieHeader(req.headers.cookie);
  if (s) destroySession(s.token);
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.session.user }));

// ---------- API privée ----------
const admin = express.Router();
admin.use(requireAuth);

admin.get('/services', (req, res) => {
  const hours = hoursOf(req);
  res.json(listServices().map((s) => adminView(s, hours)));
});

admin.post('/services', async (req, res) => {
  const s = createService(validate(req.body ?? {}));
  await checkNow(s).catch(() => {});
  res.status(201).json(adminView(s, 24));
});

admin.put('/services/:id', (req, res) => {
  const existing = serviceOr404(req);
  res.json(adminView(updateService(existing.id, validate(req.body ?? {}, existing)), 24));
});

admin.delete('/services/:id', (req, res) => {
  deleteService(serviceOr404(req).id);
  res.status(204).end();
});

admin.get('/services/:id/password', (req, res) => {
  const s = serviceOr404(req);
  console.log(`[audit] ${req.session.user} a affiché le mot de passe de « ${s.name} »`);
  res.set('Cache-Control', 'no-store').json({ password: decrypt(s.ssh_password_enc) });
});

admin.post('/services/:id/check', async (req, res) => {
  const s = serviceOr404(req);
  const result = await checkNow(s);
  res.json({ ...result, service: adminView(getService(s.id), 24) });
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON invalide' });
  console.error(err);
  res.status(500).json({ error: 'Erreur interne' });
});

// ---------- Démarrage ----------
const server = http.createServer(app);
attachTerminal(server);
server.listen(config.port, config.host, () => {
  console.log(`PersonalDashboard en écoute sur http://${config.host}:${config.port}`);
  console.log(`  Page publique : /   ·   Espace privé : /admin`);
  startMonitor();
});
