import { config } from '../config.js';
import { q, setting } from '../db/index.js';
import { cookie } from './http.js';
import { sha256, randomToken } from './security.js';

export function createSession(ctx, userId, { mfaOk, via }) {
  if (ctx.session) q.run('DELETE FROM sessions WHERE id = ?', ctx.session.id); // never reuse a pre-login session
  const token = randomToken(32), now = Date.now();
  const r = q.run('INSERT INTO sessions(token_hash, user_id, csrf, mfa_ok, via, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)',
    sha256(token), userId, randomToken(24), mfaOk ? 1 : 0, via, now, now);
  ctx.cookies.push(cookie('sid', token, { maxAge: config.session.absoluteMs }));
  ctx.session = q.get('SELECT * FROM sessions WHERE id = ?', r.lastInsertRowid);
  ctx.user = q.get('SELECT * FROM users WHERE id = ?', userId);
  return ctx.session;
}
export function endSession(ctx) {
  if (ctx.session) q.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
  ctx.cookies.push(cookie('sid', '', { maxAge: 0 }));
  ctx.session = null; ctx.user = null;
}
export function loadSession(ctx) {
  const token = ctx.cookieJar.sid;
  if (!token) return;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!s) return;
  const now = Date.now();
  const user = q.get('SELECT * FROM users WHERE id = ?', s.user_id);
  // Every request re-checks the account, so deactivation takes effect immediately.
  if (!user || user.status !== 'active' || now - s.last_seen > config.session.idleMs || now - s.created_at > config.session.absoluteMs) {
    q.run('DELETE FROM sessions WHERE id = ?', s.id);
    ctx.cookies.push(cookie('sid', '', { maxAge: 0 }));
    return;
  }
  if (now - s.last_seen > 60e3) q.run('UPDATE sessions SET last_seen = ? WHERE id = ?', now, s.id);
  ctx.session = s; ctx.user = user;
}
export const staffMfaRequired = user => (user.role === 'manager' || user.role === 'admin') && setting('staff_mfa_required') === '1';
export const staffNeedsMfa = (user, session) => staffMfaRequired(user) && !session.mfa_ok;
