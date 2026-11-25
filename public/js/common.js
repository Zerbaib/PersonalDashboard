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

export const TYPE_LABEL = { ping: 'Ping', tcp: 'TCP', http: 'HTTP(S)', dns: 'DNS' };

export function statusClass(s) { return s.up == null ? '' : s.up ? 'up' : 'down'; }
export function fmtLatency(ms) { return ms == null ? '—' : `${ms} ms`; }
export function fmtUptime(u) { return u == null ? '—' : `${u.toFixed(u === 100 ? 0 : 2)} %`; }
export function fmtAgo(ts) {
  if (!ts) return 'jamais';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `il y a ${s} s`;
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  return `il y a ${Math.round(s / 3600)} h`;
}

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtTime = (t, hours) => new Date(t).toLocaleString('fr-FR', hours > 24
  ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
  : { hour: '2-digit', minute: '2-digit' });

/**
 * Graphique en barres : une barre par tranche de temps.
 * Hauteur = latence moyenne, couleur = disponibilité (vert / orange / rouge / gris = pas de données).
 */
export function renderChart(canvas, history, hours) {
  const ok = css('--ok'), warn = css('--warn'), down = css('--down'), none = css('--none');
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

  const chart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderRadius: 2, barPercentage: 0.9, categoryPercentage: 1 }] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          displayColors: false,
          callbacks: {
            title: (items) => items[0].label,
            label: (item) => {
              const b = chart.$history[item.dataIndex];
              if (b.up == null) return 'Aucune donnée';
              return [`Disponibilité : ${(b.up * 100).toFixed(1)} %`, `Latence : ${fmtLatency(b.latency)}`];
            },
          },
        },
      },
      scales: {
        x: { display: false },
        y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,.05)' },
          ticks: { color: css('--muted'), maxTicksLimit: 3, font: { size: 10 }, callback: (v) => `${v} ms` } },
      },
    },
  });
  chart.$history = history;
  canvas._chart = chart;
  return chart;
}

export function summaryText(services) {
  const known = services.filter((s) => s.up != null);
  const down = known.filter((s) => !s.up).length;
  if (!services.length) return { cls: '', text: 'Aucun service' };
  if (down === 0) return { cls: 'up', text: 'Tous les services sont opérationnels' };
  return { cls: 'down', text: `${down} service${down > 1 ? 's' : ''} en panne` };
}
