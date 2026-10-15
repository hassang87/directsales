import crypto from 'node:crypto';
import { config } from '../config.js';

/* ---------- random values & hashing ---------- */
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const sha256buf = data => crypto.createHash('sha256').update(data).digest();
export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* ---------- passwords (scrypt) ---------- */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COMMON = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', 'iloveyou', 'bahrain123', 'welcome1', 'welcome123', 'admin123', 'letmein1', '11111111', '00000000', 'abc12345', 'manama123']);

export function passwordProblem(pw, username = '') {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Choose another.';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Don’t include your username in your password.';
  return null;
}
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || typeof pw !== 'string') { crypto.scryptSync('x', 'dummy-salt', 32, SCRYPT); return false; } // equalise timing
  const [, N, r, p, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(pw, Buffer.from(salt, 'base64'), 32, { N: +N, r: +r, p: +p, maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(h, Buffer.from(hash, 'base64'));
}

/* ---------- secret sealing (AES-256-GCM) ---------- */
export function seal(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
export function unseal(sealed) {
  const [iv, tag, enc] = sealed.split('.').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', config.encryptionKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

/* ---------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits) ---------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s) {
  s = s.replace(/=+$/, '').replace(/\s/g, '').toUpperCase();
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1e6).padStart(6, '0');
}
export const currentStep = (now = Date.now()) => Math.floor(now / 30000);
/** Returns the matched time step (to block reuse), or 0 when the code is wrong. */
export function verifyTotp(secret, code, lastStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return 0;
  const s = currentStep(now);
  for (const st of [s - 1, s, s + 1]) if (st > lastStep && safeEqual(totpAt(secret, st), code)) return st;
  return 0;
}
