import { execFile } from 'node:child_process';
import net from 'node:net';
import dns from 'node:dns';
import { config } from './config.js';
import { listServices, insertCheck, purgeChecks } from './db.js';

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

async function dnsCheck(name, type = 'A', expected, server) {
  const resolver = new dns.promises.Resolver({ timeout: 5000, tries: 2 });
  if (server) resolver.setServers([server]);
  const start = performance.now();
  try {
    const records = await resolver.resolve(name, type);
    const latency = performance.now() - start;
    const flat = JSON.stringify(records);
    if (expected && !flat.includes(expected)) {
      return { up: false, latency, message: `Valeur attendue absente (${flat.slice(0, 120)})` };
    }
    return { up: true, latency, message: flat.slice(0, 200) };
  } catch (e) {
    return { up: false, message: e.code || e.message };
  }
}

export async function runCheck(s) {
  switch (s.type) {
    case 'ping': return ping(s.target);
    case 'tcp': return tcp(s.target, s.port);
    case 'http': return http(s.target);
    case 'dns': return dnsCheck(s.target, s.dns_record_type || 'A', s.dns_expected, s.dns_server);
    default: return { up: false, message: 'Type inconnu' };
  }
}

const running = new Set();
const lastRun = new Map();

export async function checkNow(service) {
  running.add(service.id);
  lastRun.set(service.id, Date.now());
  try {
    const r = await runCheck(service);
    insertCheck(service.id, r);
    return r;
  } finally {
    running.delete(service.id);
  }
}

function tick() {
  const now = Date.now();
  for (const s of listServices()) {
    if (running.has(s.id)) continue;
    if (now - (lastRun.get(s.id) || 0) < s.interval_sec * 1000) continue;
    checkNow(s).catch((e) => console.error(`[monitor] ${s.name} :`, e.message));
  }
}

export function startMonitor() {
  tick();
  setInterval(tick, 5000);
  setInterval(() => {
    const n = purgeChecks(Date.now() - config.retentionDays * 86400 * 1000);
    if (n) console.log(`[monitor] ${n} anciennes mesures supprimées`);
  }, 3600 * 1000);
}
