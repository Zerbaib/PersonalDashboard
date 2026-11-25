import {
  $, h, api, TYPE_TAG, stateOf, fmtLatency, fmtUptime, kv, renderChart, forgetChart, initChrome, updateStatusbar,
} from './common.js';

const grid = $('#grid');
const cards = new Map();
const getHours = initChrome({ onRangeChange: () => refresh() });

function buildCard(s) {
  const refs = {
    title: h('span', { class: 'box-title' }),
    tag: h('span', { class: 'box-tag' }),
    state: h('div', { class: 'state' }),
    uptime: h('b'), latency: h('b'), u30: h('b'), u1y: h('b'),
    canvas: h('canvas'),
  };
  const el = h('article', { class: 'box', tabindex: '0' },
    refs.title, refs.tag, refs.state,
    kv([['dispo', refs.uptime], ['30j', refs.u30], ['1an', refs.u1y], ['latence', refs.latency]]),
    h('div', { class: 'chart-box' }, refs.canvas));

  const open = () => { if (el.dataset.link) window.open(el.dataset.link, '_blank', 'noopener,noreferrer'); };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return { el, refs };
}

function updateCard({ el, refs }, s, hours) {
  const st = stateOf(s);
  refs.title.textContent = s.name;
  refs.tag.textContent = TYPE_TAG[s.type];
  refs.state.className = `state ${st.cls}`;
  refs.state.textContent = st.label;
  refs.uptime.textContent = fmtUptime(s.uptime);
  refs.u30.textContent = fmtUptime(s.uptime_30d);
  refs.u1y.textContent = fmtUptime(s.uptime_1y);
  refs.latency.textContent = fmtLatency(s.latency);
  el.classList.toggle('is-down', s.up === false);
  el.classList.toggle('clickable', !!s.link_url);
  if (s.link_url) { el.dataset.link = s.link_url; el.title = `ouvrir ${s.link_url}`; }
  else { delete el.dataset.link; el.removeAttribute('title'); }
  renderChart(refs.canvas, s.history, hours);
}

async function refresh() {
  const hours = getHours();
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
    for (const [id, card] of cards) if (!seen.has(id)) { forgetChart(card.refs.canvas); card.el.remove(); cards.delete(id); }
    $('.empty', grid)?.remove();
    if (!services.length) grid.append(h('p', { class: 'empty' }, 'aucun service public pour le moment'));
    updateStatusbar(services);
  } catch (e) {
    $('#updated').textContent = `erreur : ${e.message}`;
  }
}

refresh();
setInterval(refresh, 30_000);
