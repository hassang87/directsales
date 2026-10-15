import { config } from '../config.js';
import { q, setting, settingNum } from '../db/index.js';
import { fail } from '../lib/http.js';
import { hashPassword, verifyPassword, passwordProblem, sha256, randomToken, seal, unseal, newTotpSecret, verifyTotp } from '../lib/security.js';
import { createSession, endSession, staffMfaRequired, staffNeedsMfa } from '../lib/session.js';
import { audit, rateLimit } from '../lib/services.js';
import { publicUser, managedTeamIds, hasPerm } from '../lib/access.js';

const MIN = 60e3;
const pendingTotp = new Map(); // session id → { secret, exp }  (enrolment in progress)

/** Issues a single-use link; any older unused link of the same kind for this user is revoked. */
export function issueLink(userId, kind) {
  const now = Date.now();
  q.run('UPDATE tokens SET revoked_at = ? WHERE user_id = ? AND kind = ? AND used_at IS NULL AND revoked_at IS NULL', now, userId, kind);
  const token = randomToken(32);
  const hours = settingNum(kind === 'invite' ? 'invite_hours' : 'reset_hours');
  q.run('INSERT INTO tokens(token_hash, user_id, kind, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, kind, now + hours * 3600e3);
  return { url: `${config.origin}/#/link/${token}`, expiresAt: now + hours * 3600e3 };
}
function findLink(token) {
  const t = q.get('SELECT * FROM tokens WHERE token_hash = ?', sha256(String(token)));
  if (!t || t.used_at || t.revoked_at || t.expires_at < Date.now()) fail(410, 'This link has expired or was already used. Ask your manager for a new one.', 'link_invalid');
  const u = q.get('SELECT * FROM users WHERE id = ?', t.user_id);
  if (!u || u.status === 'deactivated') fail(410, 'This account is not active. Contact your manager.', 'link_invalid');
  return { t, u };
}

export default function (r) {
  r.get('/api/session', { auth: 'public' }, ctx => {
    const base = {
      demo: config.isDemo,
      passkeysEnabled: setting('passkeys_enabled') === '1',
      maps: config.maps.browserKey ? { key: config.maps.browserKey, mapId: config.maps.mapId || 'DEMO_MAP_ID' } : null,
      staleMinutes: settingNum('stale_minutes')
    };
    if (!ctx.user) return { ...base, user: null };
    const u = ctx.user;
    return {
      ...base,
      user: { ...publicUser(u), totpEnrolled: !!u.totp_secret_enc, teams: managedTeamIds(u),
        perms: q.all('SELECT perm FROM permissions WHERE user_id = ?', u.id).map(p => p.perm),
        team: u.team_id ? q.get('SELECT name FROM teams WHERE id = ?', u.team_id)?.name : null },
      csrf: ctx.session.csrf,
      via: ctx.session.via,
      mfa: staffNeedsMfa(u, ctx.session) ? (u.totp_secret_enc ? 'verify' : 'enroll') : null,
      passkeys: q.get('SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id = ?', u.id).n
    };
  });

  r.post('/api/auth/login', { auth: 'public' }, ctx => {
    const username = String(ctx.body.username || '').trim().toLowerCase().slice(0, 60);
    if (!rateLimit('login-ip:' + ctx.ip, 30, 15 * MIN) || !rateLimit('login-user:' + username, 10, 15 * MIN))
      fail(429, 'Too many sign-in attempts. Wait a few minutes and try again.', 'rate_limited');
    const user = q.get('SELECT * FROM users WHERE username = ?', username);
    if (user && user.locked_until > Date.now()) fail(423, 'This account is locked for 15 minutes after too many failed attempts.', 'locked');
    const ok = verifyPassword(String(ctx.body.password || ''), user?.password_hash);
    if (!user || !ok || user.status !== 'active') {
      if (user) {
        const n = user.failed_logins + 1;
        q.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', n >= 10 ? 0 : n, n >= 10 ? Date.now() + 15 * MIN : user.locked_until, user.id);
        audit(user.id, n >= 10 ? 'login_locked' : 'login_failed', user.id);
      }
      fail(401, 'That username and password don’t match.', 'bad_credentials');
    }
    q.run('UPDATE users SET failed_logins = 0 WHERE id = ?', user.id);
    const needs = staffMfaRequired(user);
    createSession(ctx, user.id, { mfaOk: !needs, via: 'password' });
    audit(user.id, 'login', user.id, 'password');
    return { ok: true, mfa: needs ? (user.totp_secret_enc ? 'verify' : 'enroll') : null };
  });

  r.post('/api/auth/logout', { preMfa: true }, ctx => { audit(ctx.user.id, 'logout', ctx.user.id); endSession(ctx); return { ok: true }; });

  /* ----- two-step sign-in (TOTP) ----- */
  r.post('/api/auth/totp/verify', { preMfa: true }, ctx => {
    const u = ctx.user;
    if (!u.totp_secret_enc) fail(409, 'Two-step sign-in is not set up yet.', 'not_enrolled');
    if (!rateLimit('totp:' + u.id, 8, 5 * MIN)) fail(429, 'Too many codes tried. Wait a few minutes.', 'rate_limited');
    const step = verifyTotp(unseal(u.totp_secret_enc), String(ctx.body.code || '').trim(), u.totp_last_step);
    if (!step) { audit(u.id, 'mfa_failed', u.id); fail(401, 'That code isn’t right. Check your authenticator app and try again.', 'bad_code'); }
    q.run('UPDATE users SET totp_last_step = ? WHERE id = ?', step, u.id);
    q.run('UPDATE sessions SET mfa_ok = 1 WHERE id = ?', ctx.session.id);
    audit(u.id, 'mfa_ok', u.id, 'totp');
    return { ok: true };
  });
  r.post('/api/auth/totp/setup', { preMfa: true }, ctx => {
    const u = ctx.user;
    if (u.totp_secret_enc && !ctx.session.mfa_ok) fail(409, 'Two-step sign-in is already set up. Enter your code instead.', 'already_enrolled');
    const secret = newTotpSecret();
    pendingTotp.set(ctx.session.id, { secret, exp: Date.now() + 10 * MIN });
    const label = encodeURIComponent(`${config.rpName}:${u.username}`);
    return { secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(config.rpName)}&period=30&digits=6` };
  });
  r.post('/api/auth/totp/enable', { preMfa: true }, ctx => {
    const u = ctx.user, p = pendingTotp.get(ctx.session.id);
    if (!p || p.exp < Date.now()) fail(410, 'Setup timed out. Start again.', 'setup_expired');
    if (u.totp_secret_enc && !ctx.session.mfa_ok) fail(409, 'Two-step sign-in is already set up.', 'already_enrolled');
    if (!rateLimit('totp:' + u.id, 8, 5 * MIN)) fail(429, 'Too many codes tried. Wait a few minutes.', 'rate_limited');
    const step = verifyTotp(p.secret, String(ctx.body.code || '').trim(), 0);
    if (!step) fail(401, 'That code isn’t right. Make sure the time on your phone is correct.', 'bad_code');
    q.run('UPDATE users SET totp_secret_enc = ?, totp_last_step = ? WHERE id = ?', seal(p.secret), step, u.id);
    q.run('UPDATE sessions SET mfa_ok = 1 WHERE id = ?', ctx.session.id);
    pendingTotp.delete(ctx.session.id);
    audit(u.id, 'mfa_enrolled', u.id, 'totp');
    return { ok: true };
  });

  /* ----- invitation & reset links ----- */
  r.get('/api/auth/link/:token', { auth: 'public' }, ctx => {
    const { t, u } = findLink(ctx.params.token);
    return { kind: t.kind, name: u.name, username: u.username };
  });
  r.post('/api/auth/link/:token', { auth: 'public' }, ctx => {
    if (!rateLimit('link:' + ctx.ip, 20, 15 * MIN)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const { t, u } = findLink(ctx.params.token);
    const pw = String(ctx.body.password || '');
    const problem = passwordProblem(pw, u.username);
    if (problem) fail(400, problem, 'weak_password');
    const now = Date.now();
    q.run('UPDATE tokens SET used_at = ? WHERE id = ?', now, t.id);
    q.run("UPDATE users SET password_hash = ?, status = 'active', failed_logins = 0, locked_until = 0 WHERE id = ?", hashPassword(pw), u.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', u.id); // signs out every device
    audit(u.id, t.kind === 'invite' ? 'account_activated' : 'password_reset', u.id);
    return { ok: true, username: u.username };
  });

  r.post('/api/me/password', ctx => {
    const u = ctx.user;
    if (!rateLimit('pwchange:' + u.id, 10, 15 * MIN)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    if (!verifyPassword(String(ctx.body.current || ''), u.password_hash)) fail(401, 'Your current password is not right.', 'bad_credentials');
    const problem = passwordProblem(String(ctx.body.next || ''), u.username);
    if (problem) fail(400, problem, 'weak_password');
    q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(ctx.body.next), u.id);
    q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', u.id, ctx.session.id);
    audit(u.id, 'password_changed', u.id);
    return { ok: true };
  });

  r.get('/api/me/permissions', ctx => ({ medicalDocuments: hasPerm(ctx.user, 'medical_documents'), locationHistory: hasPerm(ctx.user, 'location_history') }));
}
