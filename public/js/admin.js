/* global Terminal, FitAddon */
import {
  $, h, api, TYPE_TAG, stateOf, fmtLatency, fmtUptime, fmtAgo, kv,
  renderChart, forgetChart, initChrome, updateStatusbar,
} from './common.js';

const grid = $('#grid');
const cards = new Map(); // id -> { el, refs, service, term, password }
let timer = null;
let getHours = () => 24;

// ---------------- Authentification ----------------
async function boot() {
  getHours = initChrome({ onRangeChange: () => { if (!$('#app').hidden) refresh(); } });
  try {
    await api('/api/me');
    showApp();
  } catch {
    $('#login').hidden = false;
    $('#summary').textContent = 'non connecté';
    $('#login-form [name=username]').focus();
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: { username: f.get('username'), password: f.get('password') } });
    e.target.reset();
    $('#login').hidden = true;
    showApp();
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
});

function showApp() {
  $('#app').hidden = false;
  $('#app-actions').hidden = false;
  refresh();
  timer = setInterval(refresh, 30_000);
  api('/api/admin/settings').then((r) => $('#notif-btn').classList.toggle('active', r.discord.configured)).catch(() => {});
}

function onAuthLost(err) {
  if (err.status === 401) { clearInterval(timer); location.reload(); return true; }
  return false;
}

// ---------------- Cartes ----------------
function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}
function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => flash(btn, 'copié ✓'));
}

function describeTarget(s) {
  if (s.type === 'tcp') return `${s.target}:${s.port}`;
  if (s.type === 'dns') return `${s.target}:${s.port ?? 53} (${s.dns_query} ${s.dns_record_type})`;
  return s.target;
}

function buildCard(s) {
  const card = { service: s, term: null, password: null };
  const refs = {
    title: h('span', { class: 'box-title' }),
    tag: h('span', { class: 'box-tag' }),
    state: h('div', { class: 'state' }),
    uptime: h('b'), latency: h('b'), checked: h('b'), u30: h('b'), u1y: h('b'),
    canvas: h('canvas'),
    msg: h('div', { class: 'msg' }),
    target: h('code'), ip: h('code'), user: h('code'), pw: h('code'),
    terminal: h('div', { class: 'console-box' }),
  };
  const btn = (label, onclick, cls = 'btn') => h('button', { class: cls, type: 'button', onclick }, label);
  refs.pwShow = btn('afficher', () => togglePassword(card), 'btn sm');
  refs.pwCopy = btn('copier', () => copyPassword(card), 'btn sm');
  refs.ipCopy = btn('copier', (e) => copy(card.service.ip, e.target), 'btn sm');
  refs.openBtn = btn('ouvrir ↗', () => window.open(card.service.link_url, '_blank', 'noopener,noreferrer'));
  refs.consoleBtn = btn('console', () => (card.term ? closeTerminal(card) : openTerminal(card)));

  card.el = h('article', { class: 'box' },
    refs.title, refs.tag, refs.state,
    kv([['dispo', refs.uptime], ['30j', refs.u30], ['1an', refs.u1y], ['latence', refs.latency], ['vérifié', refs.checked]]),
    h('div', { class: 'chart-box' }, refs.canvas),
    refs.msg,
    h('dl', { class: 'info' },
      h('dt', {}, 'cible'), h('dd', {}, refs.target),
      h('dt', {}, 'ip'), h('dd', {}, refs.ip, refs.ipCopy),
      h('dt', {}, 'user'), h('dd', {}, refs.user),
      h('dt', {}, 'password'), h('dd', {}, refs.pw, refs.pwShow, refs.pwCopy)),
    h('div', { class: 'actions' },
      refs.openBtn,
      refs.consoleBtn,
      btn('tester', (e) => checkNow(card, e.target)),
      btn('modifier', () => openForm(card.service)),
      btn('supprimer', () => remove(card), 'btn danger')),
    refs.terminal);
  card.refs = refs;
  return card;
}

function updateCard(card, s, hours) {
  const { el, refs } = card;
  if (card.service.ip !== s.ip || card.service.ssh_user !== s.ssh_user) card.password = null;
  card.service = s;

  const st = stateOf(s);
  refs.title.textContent = s.name;
  refs.tag.textContent = `${TYPE_TAG[s.type]}${s.is_public ? '' : ' #privé'}`;
  refs.state.className = `state ${st.cls}`;
  refs.state.textContent = st.label;
  refs.uptime.textContent = fmtUptime(s.uptime);
  refs.u30.textContent = fmtUptime(s.uptime_30d);
  refs.u1y.textContent = fmtUptime(s.uptime_1y);
  refs.latency.textContent = fmtLatency(s.latency);
  refs.checked.textContent = fmtAgo(s.checked_at);
  refs.msg.textContent = s.message ?? '';
  refs.msg.title = s.message ?? '';
  refs.msg.hidden = !s.message;
  refs.target.textContent = describeTarget(s);
  refs.target.title = refs.target.textContent;
  refs.ip.textContent = s.ip ? `${s.ip}${s.ssh_port !== 22 ? `:${s.ssh_port}` : ''}` : '—';
  refs.ipCopy.hidden = !s.ip;
  refs.user.textContent = s.ssh_user || '—';
  if (!card.password || refs.pwShow.textContent !== 'masquer') {
    refs.pw.textContent = s.has_password ? '••••••••' : '—';
    refs.pwShow.textContent = 'afficher';
  }
  refs.pwShow.hidden = refs.pwCopy.hidden = !s.has_password;
  refs.openBtn.hidden = !s.link_url;
  refs.consoleBtn.hidden = !(s.ip && s.has_password);
  if (refs.consoleBtn.hidden) closeTerminal(card);
  el.classList.toggle('is-down', s.up === false);
  renderChart(refs.canvas, s.history, hours);
}

async function fetchPassword(card) {
  if (card.password == null) card.password = (await api(`/api/admin/services/${card.service.id}/password`)).password ?? '';
  return card.password;
}

async function togglePassword(card) {
  const { refs } = card;
  if (refs.pwShow.textContent === 'masquer') {
    refs.pw.textContent = '••••••••';
    refs.pwShow.textContent = 'afficher';
    return;
  }
  try {
    refs.pw.textContent = await fetchPassword(card);
    refs.pwShow.textContent = 'masquer';
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

async function copyPassword(card) {
  try { copy(await fetchPassword(card), card.refs.pwCopy); } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

async function checkNow(card, btn) {
  btn.disabled = true;
  try {
    await api(`/api/admin/services/${card.service.id}/check`, { method: 'POST' });
    await refresh();
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
  btn.disabled = false;
}

async function remove(card) {
  if (!confirm(`Supprimer « ${card.service.name} » et tout son historique ?`)) return;
  try {
    await api(`/api/admin/services/${card.service.id}`, { method: 'DELETE' });
    dropCard(card);
    refresh();
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

function dropCard(card) {
  closeTerminal(card);
  forgetChart(card.refs.canvas);
  card.el.remove();
  cards.delete(card.service.id);
}

// ---------------- Console SSH ----------------
function closeTerminal(card) {
  if (!card.term) return;
  card.term.ws.close();
  card.term.observer.disconnect();
  card.term.xterm.dispose();
  card.term = null;
  card.refs.terminal.classList.remove('open');
  card.refs.terminal.replaceChildren();
  card.refs.consoleBtn.classList.remove('active');
  card.refs.consoleBtn.textContent = 'console';
  card.el.classList.remove('wide');
}

function openTerminal(card) {
  const box = card.refs.terminal;
  card.el.classList.add('wide');
  box.classList.add('open');
  card.refs.consoleBtn.classList.add('active');
  card.refs.consoleBtn.textContent = 'fermer la console';

  const xterm = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    fontFamily: '"JetBrains Mono", ui-monospace, monospace',
    // Palette Solarized Dark
    theme: {
      background: '#00212b', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#00212b', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(box);
  fit.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?id=${card.service.id}`);
  const send = (msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  const resize = () => { try { fit.fit(); } catch { /* caché */ } send({ type: 'resize', cols: xterm.cols, rows: xterm.rows }); };

  ws.onopen = resize;
  ws.onmessage = (e) => xterm.write(e.data);
  ws.onclose = () => xterm.write('\r\n\x1b[90m[session terminée]\x1b[0m\r\n');
  ws.onerror = () => xterm.write('\r\n\x1b[31m[connexion websocket impossible — session expirée ?]\x1b[0m\r\n');
  xterm.onData((data) => send({ type: 'data', data }));

  const observer = new ResizeObserver(() => resize());
  observer.observe(box);
  card.term = { xterm, ws, observer };
  // Le focus doit quitter le bouton « console », sinon Entrée referme la console.
  card.refs.consoleBtn.blur();
  requestAnimationFrame(() => xterm.focus());
  card.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- Rafraîchissement ----------------
async function refresh() {
  const hours = getHours();
  try {
    const services = await api(`/api/admin/services?hours=${hours}`);
    const seen = new Set();
    for (const s of services) {
      seen.add(s.id);
      let card = cards.get(s.id);
      if (!card) { card = buildCard(s); cards.set(s.id, card); grid.append(card.el); }
      updateCard(card, s, hours);
    }
    for (const [id, card] of cards) if (!seen.has(id)) dropCard(card);
    $('.empty', grid)?.remove();
    if (!services.length) grid.append(h('p', { class: 'empty' }, 'aucun service — « + ajouter » pour commencer'));
    updateStatusbar(services);
  } catch (e) {
    if (!onAuthLost(e)) $('#updated').textContent = `erreur : ${e.message}`;
  }
}

// ---------------- Formulaire service ----------------
const dialog = $('#dialog');
const form = $('#form');
let editing = null;

const HINTS = {
  http: 'url complète, ex : https://exemple.fr/health — en ligne si le code http est < 400.',
  ping: 'ip ou nom d’hôte, ex : 192.168.1.10 — ping icmp.',
  tcp: 'ip ou nom d’hôte + port, ex : 192.168.1.10 et 22.',
  dns: 'ip ou nom du serveur dns — en ligne s’il répond à la requête de test (nxdomain compte comme une réponse).',
};

function syncType() {
  const type = form.type.value;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(type); });
  form.port.required = type === 'tcp';
  form.port.placeholder = type === 'dns' ? '53' : '';
  form.target.placeholder = type === 'http' ? 'https://exemple.fr' : '192.168.1.10';
  $('#target-hint').textContent = HINTS[type];
}
form.type.addEventListener('change', syncType);

function openForm(s = null) {
  editing = s;
  form.reset();
  $('#form-error').textContent = '';
  $('#form-title').textContent = s ? `modifier ${s.name}` : 'nouveau service';
  form.querySelectorAll('[data-edit]').forEach((el) => { el.hidden = !s; });
  if (s) {
    for (const k of ['name', 'type', 'target', 'port', 'dns_query', 'dns_record_type', 'link_url', 'interval_sec', 'ip', 'ssh_port', 'ssh_user']) {
      if (s[k] != null) form[k].value = s[k];
    }
    form.is_public.checked = s.is_public;
    form.notify.checked = s.notify;
  }
  form.ssh_password.placeholder = s?.has_password ? 'laisser vide pour conserver' : '';
  syncType();
  dialog.showModal();
}

$('#add').addEventListener('click', () => openForm());
$('#cancel').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  for (const k of ['is_public', 'notify', 'clear_password', 'reset_fingerprint']) body[k] = form[k].checked;
  if (!['tcp', 'dns'].includes(body.type)) body.port = '';
  if (body.type !== 'dns') { body.dns_query = ''; body.dns_record_type = ''; }
  try {
    if (editing) await api(`/api/admin/services/${editing.id}`, { method: 'PUT', body });
    else await api('/api/admin/services', { method: 'POST', body });
    if (editing) { const c = cards.get(editing.id); if (c) c.password = null; }
    dialog.close();
    refresh();
  } catch (err) {
    if (!onAuthLost(err)) $('#form-error').textContent = err.message;
  }
});

// ---------------- Notifications Discord ----------------
const notifDialog = $('#notif-dialog');
const notifForm = $('#notif-form');

function showNotifStatus(info) {
  $('#notif-status').textContent = info.configured
    ? `● actif${info.from_env ? ' (DISCORD_WEBHOOK_URL)' : ''} : ${info.masked}`
    : '○ aucun webhook configuré — notifications désactivées';
  $('#notif-remove').hidden = !info.configured || info.from_env;
  $('#notif-btn').classList.toggle('active', info.configured);
}

async function notifAction(fn) {
  $('#notif-error').textContent = '';
  try { await fn(); } catch (e) { if (!onAuthLost(e)) $('#notif-error').textContent = e.message; }
}

$('#notif-btn').addEventListener('click', () => notifAction(async () => {
  notifForm.reset();
  showNotifStatus((await api('/api/admin/settings')).discord);
  notifDialog.showModal();
}));
$('#notif-cancel').addEventListener('click', () => notifDialog.close());

notifForm.addEventListener('submit', (e) => {
  e.preventDefault();
  notifAction(async () => {
    const url = notifForm.discord_webhook.value.trim();
    if (!url) throw new Error('collez l’url du webhook (ou utilisez « supprimer »)');
    showNotifStatus((await api('/api/admin/settings', { method: 'PUT', body: { discord_webhook: url } })).discord);
    notifForm.reset();
  });
});

$('#notif-remove').addEventListener('click', () => notifAction(async () => {
  if (!confirm('Supprimer le webhook Discord ? Plus aucune notification ne sera envoyée.')) return;
  showNotifStatus((await api('/api/admin/settings', { method: 'PUT', body: { discord_webhook: '' } })).discord);
}));

$('#notif-test').addEventListener('click', (e) => notifAction(async () => {
  const b = e.target;
  b.disabled = true;
  try {
    await api('/api/admin/settings/test-discord', { method: 'POST', body: { discord_webhook: notifForm.discord_webhook.value.trim() } });
    flash(b, 'envoyé ✓');
  } finally { b.disabled = false; }
}));

boot();
