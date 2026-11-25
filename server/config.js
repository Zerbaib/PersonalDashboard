import path from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[config] Variable d'environnement manquante : ${name} (voir .env.example)`);
    process.exit(1);
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: required('ADMIN_PASSWORD'),
  masterKey: required('MASTER_KEY'),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  sessionHours: Number(process.env.SESSION_HOURS || 12),
  retentionDays: Number(process.env.RETENTION_DAYS || 30),
  retentionHourlyDays: Number(process.env.RETENTION_HOURLY_DAYS || 365),
  alertAfterFailures: Math.max(1, Number(process.env.ALERT_AFTER_FAILURES || 2)),
  retrySec: Math.max(5, Number(process.env.RETRY_SEC || 20)),
};

if (config.masterKey.length < 32) {
  console.error('[config] MASTER_KEY doit contenir au moins 32 caractères (ex : openssl rand -hex 32)');
  process.exit(1);
}
if (config.adminPassword.length < 12) {
  console.error('[config] ADMIN_PASSWORD doit contenir au moins 12 caractères');
  process.exit(1);
}
