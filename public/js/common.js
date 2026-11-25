/* global Chart */

export const $ = (sel, root = document) => root.querySelector(sel);

/** Création d'élément DOM sans innerHTML (pas d'injection). */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* vide */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const TYPE_TAG = { ping: '#ping', tcp: '#tcp', http: '#http', dns: '#dns' };

export function stateOf(s) {
  if (s.up == null) return { cls: 'none', label: '○ en attente' };
  return s.up ? { cls: 'up', label: '● en ligne' } : { cls: 'down', label: '● hors ligne' };
}
export function fmtLatency(ms) { return ms == null ? '—' : `${ms} ms`; }
export function fmtUptime(u) { return u == null ? '—' : `${u.toFixed(u === 100 ? 0 : 2)} %`; }
export function fmtAgo(ts) {
  if (!ts) return 'jamais';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
}

/** Ligne « clé valeur » pour les statistiques d'une carte. */
export function kv(pairs) {
  return h('div', { class: 'kv' }, pairs.map(([label, ref]) => h('span', {}, `${label} `, ref)));
}

// ---------------- Habillage commun : thème, horloge, onglets, barre d'état ----------------
const charts = new Set();

export function initChrome({ onRangeChange }) {
  const root = document.documentElement;
  $('#theme-toggle')?.addEventListener('click', () => {
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    store.set('theme', next);
    for (const c of charts) c.destroy(); // recréés aux couleurs du nouveau thème
    charts.clear();
    document.querySelectorAll('canvas').forEach((c) => { delete c._chart; });
    onRangeChange();
  });

  const clock = $('#sb-clock');
  const tickClock = () => { clock.textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
  tickClock();
  setInterval(tickClock, 10_000);
  const host = $('#sb-host');
  if (host) host.textContent = `"${location.hostname}"`;

  const tabs = $('#range');
  let hours = Number(store.get('pd_range')) || 24;
  if (!tabs.querySelector(`[data-hours="${hours}"]`)) hours = 24;
  const sync = () => tabs.querySelectorAll('.tab').forEach((t) => {
    const on = Number(t.dataset.hours) === hours;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  sync();
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    hours = Number(t.dataset.hours);
    store.set('pd_range', hours);
    sync();
    onRangeChange();
  });
  return () => hours;
}

export function updateStatusbar(services) {
  const bar = $('#statusbar');
  const main = $('#summary');
  const known = services.filter((s) => s.up != null);
  const down = known.filter((s) => !s.up);
  bar.classList.toggle('down', down.length > 0);
  if (!services.length) main.textContent = 'aucun service';
  else if (!down.length) main.textContent = `● ${known.length}/${services.length} en ligne`;
  else main.textContent = `● ${down.length} hors ligne : ${down.map((s) => s.name).join(', ')}`;
  $('#updated').textContent = `maj ${new Date().toLocaleTimeString('fr-FR')}`;
}

// ---------------- Graphique ----------------
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtTime = (t, hours) => {
  const d = new Date(t);
  if (hours >= 8760) return `semaine du ${d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' })}`;
  if (hours >= 720) return d.toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: 'short' });
  return d.toLocaleString('fr-FR', hours > 24
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit' });
};

/**
 * Une barre par tranche de temps : hauteur = latence moyenne,
 * couleur = disponibilité (vert / jaune / rouge, neutre = pas de données).
 */
export function renderChart(canvas, history, hours) {
  const ok = css('--accent'), warn = css('--warn'), down = css('--down'), none = css('--none');
  const max = Math.max(10, ...history.map((b) => b.latency || 0));
  const data = history.map((b) => (b.up == null ? max * 0.12 : b.up === 0 ? max : b.latency ?? max * 0.12));
  const colors = history.map((b) => (b.up == null ? none : b.up >= 0.999 ? ok : b.up > 0 ? warn : down));
  const labels = history.map((b) => fmtTime(b.t, hours));

  if (canvas._chart) {
    const c = canvas._chart;
    c.data.labels = labels;
    c.data.datasets[0].data = data;
    c.data.datasets[0].backgroundColor = colors;
    c.$history = history;
    c.update('none');
    return c;
  }

  const font = { family: '"JetBrains Mono", monospace', size: 10 };
  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 0, barPercentage: 0.82, categoryPercentage: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false, cornerRadius: 0, padding: 8,
          backgroundColor: css('--bar'), titleColor: css('--accent'), bodyColor: css('--text'),
          borderColor: css('--line-2'), borderWidth: 1,
          titleFont: { ...font, size: 12, weight: 700 }, bodyFont: { ...font, size: 12 },
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => {
              const b = chart.$history[item.dataIndex];
              if (b.up == null) return 'aucune donnée';
              return [`dispo   ${(b.up * 100).toFixed(1)} %`, `latence ${fmtLatency(b.latency)}`];
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: {
          beginAtZero: true, border: { display: false },
          grid: { color: css('--line'), drawTicks: false },
          ticks: { color: css('--muted'), maxTicksLimit: 3, font, padding: 6, callback: (v) => `${v}ms` },
        },
      },
    },
  });
  chart.$history = history;
  canvas._chart = chart;
  charts.add(chart);
  return chart;
}

/** Retire les graphiques des cartes supprimées. */
export function forgetChart(canvas) {
  if (canvas._chart) { charts.delete(canvas._chart); canvas._chart.destroy(); delete canvas._chart; }
}
