import { getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export const DISCORD_WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const COLORS = { down: 0xf85149, up: 0x2ea043, info: 0x4f8cff };
const TYPE_LABEL = { ping: 'Ping', tcp: 'TCP', http: 'HTTP(S)', dns: 'DNS' };

// ---------- Réglage du webhook (chiffré en base, ou variable d'environnement) ----------
export function getWebhookUrl() {
  const enc = getSetting('discord_webhook');
  if (enc) {
    try { return decrypt(enc); } catch { /* MASTER_KEY modifiée */ }
  }
  return process.env.DISCORD_WEBHOOK_URL || null;
}

export function setWebhookUrl(url) {
  setSetting('discord_webhook', url ? encrypt(url) : null);
}

export function webhookInfo() {
  const url = getWebhookUrl();
  return {
    configured: !!url,
    from_env: !getSetting('discord_webhook') && !!process.env.DISCORD_WEBHOOK_URL,
    // On ne renvoie jamais le jeton complet au navigateur
    masked: url ? url.replace(/\/[\w-]+$/, '/••••••••') : null,
  };
}

// ---------- Mise en forme ----------
const unix = (ms) => Math.floor(ms / 1000);

export function fmtDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d} j ${h} h`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min ${String(sec).padStart(2, '0')} s`;
  return `${sec} s`;
}

function targetOf(s) {
  if (s.type === 'tcp') return `${s.target}:${s.port}`;
  if (s.type === 'dns') return `${s.target}:${s.port ?? 53} (${s.dns_query} ${s.dns_record_type})`;
  return s.target;
}

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const code = (text) => `\`${clip(String(text).replace(/`/g, "'"), 200)}\``;

function base(s, embed) {
  return {
    username: 'PersonalDashboard',
    allowed_mentions: { parse: [] }, // un nom de service ne peut pas déclencher de @everyone
    embeds: [{
      ...embed,
      ...(s?.link_url ? { url: s.link_url } : {}),
      footer: { text: 'PersonalDashboard' },
      timestamp: new Date().toISOString(),
    }],
  };
}

export function downPayload(s, result, since) {
  return base(s, {
    title: clip(`🔴 ${s.name} est hors ligne`, 256),
    description: `Le service ne répond plus depuis <t:${unix(since)}:R>.`,
    color: COLORS.down,
    fields: [
      { name: 'Type', value: TYPE_LABEL[s.type], inline: true },
      { name: 'Cible', value: code(targetOf(s)), inline: true },
      { name: 'Début de la panne', value: `<t:${unix(since)}:f>`, inline: true },
      { name: 'Erreur', value: code(result.message || 'Inconnue'), inline: false },
    ],
  });
}

export function upPayload(s, result, since, now = Date.now()) {
  return base(s, {
    title: clip(`🟢 ${s.name} est de nouveau en ligne`, 256),
    description: `Le service est rétabli après **${fmtDuration(now - since)}** d’interruption.`,
    color: COLORS.up,
    fields: [
      { name: 'Type', value: TYPE_LABEL[s.type], inline: true },
      { name: 'Cible', value: code(targetOf(s)), inline: true },
      { name: 'Latence', value: result.latency != null ? `${Math.round(result.latency)} ms` : '—', inline: true },
      { name: 'Panne', value: `<t:${unix(since)}:t> → <t:${unix(now)}:t>`, inline: false },
    ],
  });
}

export function testPayload() {
  return base(null, {
    title: '🔔 Test de notification',
    description: 'Les alertes de PersonalDashboard arriveront dans ce salon : '
      + 'un message quand un service tombe, un autre quand il revient.',
    color: COLORS.info,
  });
}

// ---------- Envoi ----------
export async function sendDiscord(payload, url = getWebhookUrl()) {
  if (!url) return false;
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) { // limite de débit Discord : on attend puis on réessaie
      const { retry_after: wait = 1 } = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, Math.min(wait, 10) * 1000));
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Discord a répondu ${res.status}${detail ? ` : ${clip(detail, 200)}` : ''}`);
    }
    return true;
  }
  throw new Error('Discord : trop de requêtes, message abandonné');
}
