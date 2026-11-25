import crypto from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import { Client } from 'ssh2';
import { sessionFromCookieHeader } from './auth.js';
import { getService, setFingerprint } from './db.js';
import { decrypt } from './crypto.js';

function sameOrigin(req) {
  try { return new URL(req.headers.origin).host === req.headers.host; } catch { return false; }
}

function reject(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

export function attachTerminal(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws/terminal') return reject(socket, 404, 'Not Found');
    if (!sameOrigin(req)) return reject(socket, 403, 'Forbidden');
    const session = sessionFromCookieHeader(req.headers.cookie);
    if (!session) return reject(socket, 401, 'Unauthorized');
    const service = getService(Number(url.searchParams.get('id')));
    if (!service) return reject(socket, 404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => openShell(ws, service, session, req.socket.remoteAddress));
  });
}

function openShell(ws, service, session, ip) {
  const write = (s) => { if (ws.readyState === ws.OPEN) ws.send(s); };
  const fail = (msg) => { write(`\r\n\x1b[31m${msg}\x1b[0m\r\n`); ws.close(); };

  if (!service.ip || !service.ssh_user) return fail('IP ou utilisateur SSH non configuré pour ce service.');
  let password;
  try { password = decrypt(service.ssh_password_enc); } catch { return fail('Impossible de déchiffrer le mot de passe (MASTER_KEY modifiée ?).'); }
  if (!password) return fail('Aucun mot de passe SSH enregistré.');

  console.log(`[terminal] ${session.user} (${ip}) -> ${service.ssh_user}@${service.ip}:${service.ssh_port} [${service.name}]`);
  write(`\x1b[90mConnexion à ${service.ssh_user}@${service.ip}:${service.ssh_port}...\x1b[0m\r\n`);

  const conn = new Client();
  const out = new StringDecoder('utf8');
  const err = new StringDecoder('utf8');
  let stream = null;
  let fingerprintMismatch = false;
  let pendingSize = { cols: 80, rows: 24 };

  conn.on('ready', () => {
    conn.shell({ term: 'xterm-256color', ...pendingSize }, (e, s) => {
      if (e) return fail(`Erreur shell : ${e.message}`);
      stream = s;
      s.on('data', (d) => write(out.write(d)));
      s.stderr.on('data', (d) => write(err.write(d)));
      s.on('close', () => { conn.end(); ws.close(); });
    });
  });
  conn.on('error', (e) => fail(fingerprintMismatch
    ? "L'empreinte de la clé SSH du serveur a changé ! Connexion refusée. Réinitialisez l'empreinte dans l'édition du service si ce changement est légitime."
    : `Erreur SSH : ${e.message}`));
  conn.on('close', () => ws.close());

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'data' && typeof msg.data === 'string') stream?.write(msg.data);
    else if (msg.type === 'resize') {
      const cols = Math.max(10, Math.min(500, msg.cols | 0));
      const rows = Math.max(5, Math.min(200, msg.rows | 0));
      pendingSize = { cols, rows };
      stream?.setWindow(rows, cols, 0, 0);
    }
  });
  ws.on('close', () => conn.end());

  conn.connect({
    host: service.ip,
    port: service.ssh_port || 22,
    username: service.ssh_user,
    password,
    readyTimeout: 15000,
    keepaliveInterval: 20000,
    // TOFU : on mémorise l'empreinte de la clé hôte à la 1re connexion, puis on la vérifie.
    hostVerifier: (key) => {
      const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64');
      if (!service.ssh_fingerprint) {
        setFingerprint(service.id, fp);
        write(`\x1b[33mPremière connexion : empreinte enregistrée ${fp}\x1b[0m\r\n`);
        return true;
      }
      if (service.ssh_fingerprint === fp) return true;
      fingerprintMismatch = true;
      return false;
    },
  });
}
