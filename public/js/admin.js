/* global Terminal, FitAddon */
import { $, h, api, TYPE_LABEL, statusClass, fmtLatency, fmtUptime, fmtAgo, renderChart, summaryText } from './common.js';

const grid = $('#grid');
const range = $('#range');
const cards = new Map(); // id -> { el, refs, service, term }
let timer = null;

// ---------------- Authentification ----------------
async function boot() {
  try {
    await api('/api/me');
    showApp();
  } catch {
    $('#login').hidden = false;
    $('#login [name=username]').focus();
  }
}

$('#login').addEventListener('submit', async (e) => {
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
  try { range.value = localStorage.getItem('pd_range') || '24'; } catch { /* ignore */ }
  refresh();
  timer = setInterval(refresh, 30_000);
}

range.addEventListener('change', () => {
  try { localStorage.setItem('pd_range', range.value); } catch { /* ignore */ }
  refresh();
});

function onAuthLost(err) {
  if (err.status === 401) { clearInterval(timer); location.reload(); return true; }
  return false;
}

// ---------------- Cartes ----------------
function copy(text, btn) {
  navigator.clipboard?.writeText(text).then(() => {
    const old = btn.textContent;
    btn.textContent = 'Copié ✓';
    setTimeout(() => { btn.textContent = old; }, 1200);
  });
}

function buildCard(s) {
  const refs = {
    dot: h('span', { class: 'dot' }),
    name: h('span', { class: 'name' }),
    type: h('span', { class: 'badge' }),
    priv: h('span', { class: 'badge private' }, 'Privé'),
    uptime: h('b'), latency: h('b'), checked: h('b'),
    canvas: h('canvas'),
    target: h('code'), ip: h('code'), user: h('code'), pw: h('code'),
    msg: h('div', { class: 'msg' }),
    terminal: h('div', { class: 'console-box' }),
  };
  refs.pwShow = h('button', { class: 'btn sm', type: 'button', onclick: () => togglePassword(card) }, 'Afficher');
  refs.pwCopy = h('button', { class: 'btn sm', type: 'button', onclick: () => copyPassword(card) }, 'Copier');
  refs.ipCopy = h('button', { class: 'btn sm', type: 'button', onclick: (e) => copy(card.service.ip, e.target) }, 'Copier');
  refs.openBtn = h('button', { class: 'btn', type: 'button', onclick: () => window.open(card.service.link_url, '_blank', 'noopener,noreferrer') }, 'Ouvrir ↗');
  refs.consoleBtn = h('button', { class: 'btn', type: 'button', onclick: () => toggleTerminal(card) }, 'Console');

  const el = h('article', { class: 'card' },
    h('div', { class: 'card-head' }, refs.dot, refs.name, refs.priv, refs.type),
    h('div', { class: 'stats' },
      h('span', {}, 'Dispo. ', refs.uptime),
      h('span', {}, 'Latence ', refs.latency),
      h('span', {}, 'Vérifié ', refs.checked)),
    h('div', { class: 'chart-box' }, refs.canvas),
    refs.msg,
    h('dl', { class: 'info' },
      h('dt', {}, 'Cible'), h('dd', {}, refs.target),
      h('dt', {}, 'IP'), h('dd', {}, refs.ip, refs.ipCopy),
      h('dt', {}, 'Utilisateur'), h('dd', {}, refs.user),
      h('dt', {}, 'Mot de passe'), h('dd', {}, refs.pw, refs.pwShow, refs.pwCopy)),
    h('div', { class: 'actions' },
      refs.openBtn,
      refs.consoleBtn,
      h('button', { class: 'btn', type: 'button', onclick: (e) => checkNow(card, e.target) }, 'Tester'),
      h('button', { class: 'btn', type: 'button', onclick: () => openForm(card.service) }, 'Modifier'),
      h('button', { class: 'btn danger', type: 'button', onclick: () => remove(card) }, 'Supprimer')),
    refs.terminal);

  const card = { el, refs, service: s, term: null, password: null };
  return card;
}

function updateCard(card, s, hours) {
  const { el, refs } = card;
  const hostChanged = card.service.ip !== s.ip || card.service.ssh_user !== s.ssh_user;
  card.service = s;
  if (hostChanged) card.password = null;

  refs.dot.className = `dot ${statusClass(s)}`;
  refs.name.textContent = s.name;
  refs.type.textContent = TYPE_LABEL[s.type];
  refs.priv.hidden = s.is_public;
  refs.uptime.textContent = fmtUptime(s.uptime);
  refs.latency.textContent = fmtLatency(s.latency);
  refs.checked.textContent = fmtAgo(s.checked_at);
  refs.msg.textContent = s.message ?? '';
  refs.msg.title = s.message ?? '';
  refs.target.textContent = s.type === 'tcp' ? `${s.target}:${s.port}` : s.target;
  refs.target.title = refs.target.textContent;
  refs.ip.textContent = s.ip ? `${s.ip}${s.ssh_port !== 22 ? `:${s.ssh_port}` : ''}` : '—';
  refs.ipCopy.hidden = !s.ip;
  refs.user.textContent = s.ssh_user || '—';
  if (!card.password) refs.pw.textContent = s.has_password ? '••••••••' : '—';
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
  if (refs.pwShow.textContent === 'Masquer') {
    refs.pw.textContent = '••••••••';
    refs.pwShow.textContent = 'Afficher';
    return;
  }
  try {
    refs.pw.textContent = await fetchPassword(card);
    refs.pwShow.textContent = 'Masquer';
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

async function copyPassword(card) {
  try { copy(await fetchPassword(card), card.refs.pwCopy); } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

async function checkNow(card, btn) {
  btn.disabled = true;
  try {
    const r = await api(`/api/admin/services/${card.service.id}/check`, { method: 'POST' });
    updateCard(card, r.service, 24);
    refresh();
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
  btn.disabled = false;
}

async function remove(card) {
  if (!confirm(`Supprimer « ${card.service.name} » et tout son historique ?`)) return;
  try {
    await api(`/api/admin/services/${card.service.id}`, { method: 'DELETE' });
    closeTerminal(card);
    card.el.remove();
    cards.delete(card.service.id);
    refresh();
  } catch (e) { if (!onAuthLost(e)) alert(e.message); }
}

// ---------------- Console SSH ----------------
function toggleTerminal(card) {
  if (card.term) closeTerminal(card);
  else openTerminal(card);
}

function closeTerminal(card) {
  if (!card.term) return;
  card.term.ws.close();
  card.term.observer.disconnect();
  card.term.xterm.dispose();
  card.term = null;
  card.refs.terminal.classList.remove('open');
  card.refs.terminal.replaceChildren();
  card.refs.consoleBtn.classList.remove('active');
  card.refs.consoleBtn.textContent = 'Console';
  card.el.classList.remove('wide');
}

function openTerminal(card) {
  const box = card.refs.terminal;
  card.el.classList.add('wide');
  box.classList.add('open');
  card.refs.consoleBtn.classList.add('active');
  card.refs.consoleBtn.textContent = 'Fermer la console';

  const xterm = new Terminal({
    cursorBlink: true, fontSize: 13, scrollback: 5000, convertEol: false,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    theme: { background: '#000000' },
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
  ws.onclose = () => xterm.write('\r\n\x1b[90m[Session terminée]\x1b[0m\r\n');
  ws.onerror = () => xterm.write('\r\n\x1b[31m[Connexion WebSocket impossible — session expirée ?]\x1b[0m\r\n');
  xterm.onData((data) => send({ type: 'data', data }));

  const observer = new ResizeObserver(() => resize());
  observer.observe(box);
  card.term = { xterm, ws, observer };
  // Le focus doit quitter le bouton « Console », sinon Entrée referme la console.
  card.refs.consoleBtn.blur();
  requestAnimationFrame(() => xterm.focus());
  card.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ---------------- Rafraîchissement ----------------
async function refresh() {
  const hours = Number(range.value);
  try {
    const services = await api(`/api/admin/services?hours=${hours}`);
    const seen = new Set();
    for (const s of services) {
      seen.add(s.id);
      let card = cards.get(s.id);
      if (!card) { card = buildCard(s); cards.set(s.id, card); grid.append(card.el); }
      updateCard(card, s, hours);
    }
    for (const [id, card] of cards) if (!seen.has(id)) { closeTerminal(card); card.el.remove(); cards.delete(id); }
    $('.empty', grid)?.remove();
    if (!services.length) grid.append(h('div', { class: 'empty' }, 'Aucun service. Cliquez sur « + Ajouter » pour commencer.'));

    const sum = summaryText(services);
    $('#summary').replaceChildren(h('span', { class: `dot ${sum.cls}` }), h('span', {}, sum.text));
    $('#updated').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (e) {
    if (!onAuthLost(e)) $('#updated').textContent = `Erreur : ${e.message}`;
  }
}

// ---------------- Formulaire ----------------
const dialog = $('#dialog');
const form = $('#form');
let editing = null;

const HINTS = {
  http: 'URL complète, ex : https://exemple.fr/health — en ligne si le code HTTP est < 400.',
  ping: 'IP ou nom d’hôte, ex : 192.168.1.10 — ping ICMP.',
  tcp: 'IP ou nom d’hôte + port, ex : 192.168.1.10 et 22.',
  dns: 'Nom de domaine à résoudre, ex : exemple.fr.',
};

function syncType() {
  const type = form.type.value;
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== type; });
  form.port.required = type === 'tcp';
  $('#target-hint').textContent = HINTS[type];
  form.target.placeholder = type === 'http' ? 'https://exemple.fr' : type === 'dns' ? 'exemple.fr' : '192.168.1.10';
}
form.type.addEventListener('change', syncType);

function openForm(s = null) {
  editing = s;
  form.reset();
  $('#form-error').textContent = '';
  $('#form-title').textContent = s ? `Modifier « ${s.name} »` : 'Ajouter un service';
  form.querySelectorAll('[data-edit]').forEach((el) => { el.hidden = !s; });
  if (s) {
    for (const k of ['name', 'type', 'target', 'port', 'dns_record_type', 'dns_expected', 'dns_server', 'link_url', 'interval_sec', 'ip', 'ssh_port', 'ssh_user']) {
      if (s[k] != null) form[k].value = s[k];
    }
    form.is_public.checked = s.is_public;
    form.ssh_password.placeholder = s.has_password ? 'Laisser vide pour conserver' : '';
  } else {
    form.ssh_password.placeholder = '';
  }
  syncType();
  dialog.showModal();
}

$('#add').addEventListener('click', () => openForm());
$('#cancel').addEventListener('click', () => dialog.close());

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(form);
  const body = Object.fromEntries(f.entries());
  body.is_public = form.is_public.checked;
  body.clear_password = form.clear_password.checked;
  body.reset_fingerprint = form.reset_fingerprint.checked;
  if (body.type !== 'tcp') body.port = '';
  if (body.type !== 'dns') { body.dns_expected = ''; body.dns_server = ''; body.dns_record_type = ''; }
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

boot();
