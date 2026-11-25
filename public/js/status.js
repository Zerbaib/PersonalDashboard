import { $, h, api, TYPE_LABEL, statusClass, fmtLatency, fmtUptime, renderChart, summaryText } from './common.js';

const grid = $('#grid');
const range = $('#range');
const cards = new Map();

try { range.value = localStorage.getItem('pd_range') || '24'; } catch { /* stockage indisponible */ }
range.addEventListener('change', () => {
  try { localStorage.setItem('pd_range', range.value); } catch { /* ignore */ }
  refresh();
});

function buildCard(s) {
  const refs = {
    dot: h('span', { class: 'dot' }),
    name: h('span', { class: 'name' }),
    uptime: h('b'), latency: h('b'),
    canvas: h('canvas'),
  };
  const el = h('article', { class: 'card', tabindex: '0' },
    h('div', { class: 'card-head' }, refs.dot, refs.name, h('span', { class: 'badge' }, TYPE_LABEL[s.type])),
    h('div', { class: 'stats' },
      h('span', {}, 'Disponibilité ', refs.uptime),
      h('span', {}, 'Latence ', refs.latency)),
    h('div', { class: 'chart-box' }, refs.canvas));

  const open = () => { if (el.dataset.link) window.open(el.dataset.link, '_blank', 'noopener,noreferrer'); };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return { el, refs };
}

function updateCard(card, s, hours) {
  const { el, refs } = card;
  refs.dot.className = `dot ${statusClass(s)}`;
  refs.name.textContent = s.name;
  refs.uptime.textContent = fmtUptime(s.uptime);
  refs.latency.textContent = fmtLatency(s.latency);
  el.classList.toggle('is-down', s.up === false);
  el.classList.toggle('clickable', !!s.link_url);
  if (s.link_url) { el.dataset.link = s.link_url; el.title = `Ouvrir ${s.link_url}`; }
  else { delete el.dataset.link; el.removeAttribute('title'); }
  renderChart(refs.canvas, s.history, hours);
}

async function refresh() {
  const hours = Number(range.value);
  try {
    const services = await api(`/api/status?hours=${hours}`);
    const seen = new Set();
    for (const s of services) {
      seen.add(s.id);
      let card = cards.get(s.id);
      if (!card) { card = buildCard(s); cards.set(s.id, card); }
      grid.append(card.el); // conserve l'ordre du serveur
      updateCard(card, s, hours);
    }
    for (const [id, card] of cards) if (!seen.has(id)) { card.el.remove(); cards.delete(id); }
    if (!services.length) grid.replaceChildren(h('div', { class: 'empty' }, 'Aucun service public pour le moment.'));
    else $('.empty', grid)?.remove();

    const sum = summaryText(services);
    $('#summary').replaceChildren(h('span', { class: `dot ${sum.cls}` }), h('span', {}, sum.text));
    $('#updated').textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
  } catch (e) {
    $('#updated').textContent = `Erreur de chargement : ${e.message}`;
  }
}

refresh();
setInterval(refresh, 30_000);
