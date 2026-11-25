import { execFile } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns';
import { config } from './config.js';
import { listServices, getService, insertCheck, setState, purge } from './db.js';
import { sendDiscord, downPayload, upPayload } from './notify.js';

const TIMEOUT = 10_000;
const HOST_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.\-:]*[a-zA-Z0-9])?$/;

function ping(host) {
  return new Promise((resolve) => {
    if (!HOST_RE.test(host)) return resolve({ up: false, message: 'Hôte invalide' });
    const start = performance.now();
    execFile('ping', ['-c', '1', '-W', '5', host], { timeout: TIMEOUT }, (err, stdout) => {
      if (err) {
        const message = err.code === 'ENOENT' ? 'Commande ping introuvable' : 'Pas de réponse ICMP';
        return resolve({ up: false, message });
      }
      const m = /time[=<]([\d.]+)\s*ms/.exec(stdout);
      resolve({ up: true, latency: m ? Number(m[1]) : performance.now() - start });
    });
  });
}

function tcp(host, port) {
  return new Promise((resolve) => {
    const start = performance.now();
    const socket = net.connect({ host, port, timeout: TIMEOUT });
    const done = (r) => { socket.destroy(); resolve(r); };
    socket.once('connect', () => done({ up: true, latency: performance.now() - start }));
    socket.once('timeout', () => done({ up: false, message: 'Délai dépassé' }));
    socket.once('error', (e) => done({ up: false, message: e.code || e.message }));
  });
}

async function http(url) {
  const start = performance.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT),
      headers: { 'User-Agent': 'PersonalDashboard-Monitor/1.0' } });
    await res.body?.cancel();
    const latency = performance.now() - start;
    return res.status < 400
      ? { up: true, latency, message: `HTTP ${res.status}` }
      : { up: false, latency, message: `HTTP ${res.status}` };
  } catch (e) {
    return { up: false, message: e.cause?.code || e.name || e.message };
  }
}

// Le serveur DNS est considéré en ligne s'il répond à la requête de test.
// NXDOMAIN / NODATA sont des réponses valides : le serveur fonctionne.
const DNS_ALIVE = { ENOTFOUND: 'NXDOMAIN', ENODATA: 'pas d’enregistrement' };
const DNS_ERRORS = {
  ETIMEOUT: 'Pas de réponse (délai dépassé)',
  ECONNREFUSED: 'Connexion refusée',
  ESERVFAIL: 'SERVFAIL : le serveur n’a pas pu résoudre le domaine de test',
  EREFUSED: 'REFUSED : requête refusée (domaine de test non autorisé sur ce serveur ?)',
  EBADRESP: 'Réponse invalide',
};

async function dnsCheck(server, port, query, type) {
  let ip = server;
  if (!net.isIP(server)) {
    try { ip = (await dns.promises.lookup(server)).address; } catch {
      return { up: false, message: `Impossible de trouver l’adresse de ${server}` };
    }
  }
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  resolver.setServers([net.isIPv6(ip) ? `[${ip}]:${port}` : `${ip}:${port}`]);
  const start = performance.now();
  try {
    const records = await resolver.resolve(query, type);
    return { up: true, latency: performance.now() - start, message: `${query} ${type} → ${JSON.stringify(records).slice(0, 150)}` };
  } catch (e) {
    const latency = performance.now() - start;
    if (DNS_ALIVE[e.code]) return { up: true, latency, message: `${query} ${type} → ${DNS_ALIVE[e.code]}` };
    return { up: false, message: DNS_ERRORS[e.code] || e.code || e.message };
  }
}

export async function runCheck(s) {
  switch (s.type) {
    case 'ping': return ping(s.target);
    case 'tcp': return tcp(s.target, s.port);
    case 'http': return http(s.target);
    case 'dns': return dnsCheck(s.target, s.port || 53, s.dns_query || 'example.com', s.dns_record_type || 'A');
    default: return { up: false, message: 'Type inconnu' };
  }
}

const running = new Set();
const lastRun = new Map();

function notify(s, payload, label) {
  if (!s.notify) return;
  sendDiscord(payload)
    .then((sent) => sent && console.log(`[discord] ${label} : ${s.name}`))
    .catch((e) => console.error(`[discord] Échec de l'envoi (${s.name}) :`, e.message));
}

/**
 * Machine à états : une panne n'est confirmée (et notifiée) qu'après
 * `alertAfterFailures` échecs consécutifs ; le retour est notifié dès le 1er succès.
 */
function updateState(id, r) {
  const s = getService(id); // état le plus récent
  if (!s) return;
  const now = Date.now();
  if (r.up) {
    if (s.state === 'down') notify(s, upPayload(s, r, s.state_since ?? now, now), 'rétabli');
    if (s.state !== 'up' || s.fail_streak) {
      setState(id, { state: 'up', state_since: s.state === 'up' ? s.state_since : now, fail_streak: 0, fail_since: null });
    }
    return;
  }
  const streak = s.fail_streak + 1;
  const failSince = s.fail_since ?? now;
  if (s.state !== 'down' && streak >= config.alertAfterFailures) {
    setState(id, { state: 'down', state_since: failSince, fail_streak: streak, fail_since: failSince });
    notify(s, downPayload(s, r, failSince), 'hors ligne');
  } else {
    setState(id, { state: s.state, state_since: s.state_since, fail_streak: streak, fail_since: failSince });
  }
}

export async function checkNow(service) {
  running.add(service.id);
  lastRun.set(service.id, Date.now());
  try {
    const r = await runCheck(service);
    insertCheck(service.id, r);
    updateState(service.id, r);
    return r;
  } finally {
    running.delete(service.id);
  }
}

function tick() {
  const now = Date.now();
  for (const s of listServices()) {
    if (running.has(s.id)) continue;
    // Échec non encore confirmé : on revérifie plus vite pour confirmer (ou non) la panne
    const confirming = s.fail_streak > 0 && s.state !== 'down';
    const wait = confirming ? Math.min(config.retrySec, s.interval_sec) : s.interval_sec;
    if (now - (lastRun.get(s.id) || 0) < wait * 1000) continue;
    checkNow(s).catch((e) => console.error(`[monitor] ${s.name} :`, e.message));
  }
}

export function startMonitor() {
  tick();
  setInterval(tick, 5000);
  setInterval(() => {
    const now = Date.now();
    const n = purge(now - config.retentionDays * 86400 * 1000, now - config.retentionHourlyDays * 86400 * 1000);
    if (n) console.log(`[monitor] ${n} anciennes mesures supprimées`);
  }, 3600 * 1000);
}
