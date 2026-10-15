import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

// Load .env if present (Node's built-in loader; values already in the environment win).
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile) && !process.env.SKIP_DOTENV) {
  try { process.loadEnvFile(envFile); } catch { /* ignore malformed file; startup checks below catch missing values */ }
}

const env = process.env;
const mode = env.APP_MODE || 'production';
const port = Number(env.PORT || 3000);
const origin = (env.APP_ORIGIN || `http://localhost:${port}`).replace(/\/$/, '');
const dataDir = path.resolve(root, env.DATA_DIR || './data');

function encryptionKey() {
  if (env.APP_ENCRYPTION_KEY) {
    const k = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64');
    if (k.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    return k;
  }
  if (mode === 'production') throw new Error('APP_ENCRYPTION_KEY is required in production. See .env.example.');
  // Demo/test: keep a generated key next to the data so restarts can still decrypt.
  fs.mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, '.dev-encryption-key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'base64');
}

export const config = {
  root,
  mode,
  isDemo: mode === 'demo',
  isProd: mode === 'production',
  isTest: mode === 'test',
  port,
  origin,
  rpId: new URL(origin).hostname,
  rpName: 'Direct Sales Portal',
  dataDir,
  filesDir: path.join(dataDir, 'private-files'),
  dbFile: path.join(dataDir, 'portal.sqlite'),
  publicDir: path.join(root, 'public'),
  trustProxy: env.TRUST_PROXY === 'true',
  secureCookies: origin.startsWith('https://'),
  encryptionKey: encryptionKey(),
  maps: { browserKey: env.GOOGLE_MAPS_BROWSER_KEY || '', mapId: env.GOOGLE_MAPS_MAP_ID || '' },
  session: { idleMs: 12 * 3600e3, absoluteMs: 14 * 24 * 3600e3 },
  tz: 'Asia/Bahrain'
};
