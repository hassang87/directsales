import { config } from '../config.js';
import { q, setting } from '../db/index.js';
import { fail, cookie } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/security.js';
import { createSession, staffMfaRequired } from '../lib/session.js';
import { audit, rateLimit, notify } from '../lib/services.js';
import { verifyRegistration, verifyAuthentication, WebAuthnError } from '../lib/webauthn.js';

const TTL = 5 * 60e3;
const userHandle = id => Buffer.from(`dsp-user-${id}`).toString('base64url');
const enabled = () => { if (setting('passkeys_enabled') !== '1') fail(403, 'Passkeys are turned off by your administrator.', 'passkeys_off'); };
function challengeFrom(cred) {
  try { return JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8')).challenge; }
  catch { fail(400, 'The passkey response could not be read.', 'bad_passkey'); }
}
function takeChallenge(challenge, kind, binding) {
  const c = q.get('SELECT * FROM webauthn_challenges WHERE challenge = ? AND kind = ?', String(challenge), kind);
  if (!c || c.used_at || c.expires_at < Date.now() || c.binding !== binding) fail(400, 'This passkey request expired. Try again.', 'challenge_invalid');
  q.run('UPDATE webauthn_challenges SET used_at = ? WHERE challenge = ?', Date.now(), c.challenge);
  return c;
}
const listFor = userId => q.all('SELECT id, device_label label, created_at createdAt, last_used_at lastUsedAt, backed_up synced FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at', userId);

export default function (r) {
  /* ----- add a passkey (signed in) ----- */
  r.post('/api/passkeys/register/options', ctx => {
    enabled();
    const u = ctx.user, challenge = randomToken(32);
    q.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', Date.now());
    q.run('INSERT INTO webauthn_challenges(challenge, kind, user_id, binding, expires_at) VALUES (?, ?, ?, ?, ?)', challenge, 'register', u.id, String(ctx.session.id), Date.now() + TTL);
    return {
      challenge,
      rp: { name: config.rpName, id: config.rpId },
      user: { id: userHandle(u.id), name: u.username, displayName: u.name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      attestation: 'none',
      timeout: TTL,
      excludeCredentials: q.all('SELECT credential_id FROM webauthn_credentials WHERE user_id = ?', u.id).map(c => ({ type: 'public-key', id: c.credential_id }))
    };
  });
  r.post('/api/passkeys/register/verify', ctx => {
    enabled();
    const u = ctx.user, cred = ctx.body.credential;
    const label = String(ctx.body.label || 'This phone').trim().slice(0, 60) || 'This phone';
    takeChallenge(challengeFrom(cred), 'register', String(ctx.session.id));
    let v;
    try { v = verifyRegistration(cred, { challenge: challengeFrom(cred), origin: config.origin, rpId: config.rpId }); }
    catch (e) { if (e instanceof WebAuthnError) { audit(u.id, 'passkey_add_failed', u.id, e.message); fail(400, 'The passkey could not be saved: ' + e.message, 'bad_passkey'); } throw e; }
    if (q.get('SELECT 1 FROM webauthn_credentials WHERE credential_id = ?', v.credentialId)) fail(409, 'This passkey is already registered.', 'duplicate');
    q.run(`INSERT INTO webauthn_credentials(user_id, credential_id, public_key_jwk, alg, sign_count, transports, device_label, backup_eligible, backed_up, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.id, v.credentialId, JSON.stringify(v.jwk), v.alg, v.signCount, JSON.stringify(v.transports), label, v.backupEligible ? 1 : 0, v.backedUp ? 1 : 0, Date.now());
    audit(u.id, 'passkey_added', u.id, label);
    notify(u.id, 'A passkey was added to your account. If this wasn’t you, contact your manager.');
    return { ok: true, passkeys: listFor(u.id) };
  });

  r.get('/api/passkeys', ctx => listFor(ctx.user.id));
  r.delete('/api/passkeys/:id', ctx => {
    const c = q.get('SELECT * FROM webauthn_credentials WHERE id = ? AND user_id = ?', Number(ctx.params.id), ctx.user.id);
    if (!c) fail(404, 'Passkey not found.');
    q.run('DELETE FROM webauthn_credentials WHERE id = ?', c.id);
    audit(ctx.user.id, 'passkey_removed', ctx.user.id, c.device_label);
    return { ok: true, passkeys: listFor(ctx.user.id) };
  });

  /* ----- sign in with a passkey (signed out) ----- */
  r.post('/api/passkeys/login/options', { auth: 'public' }, ctx => {
    enabled();
    if (!rateLimit('pk-opts:' + ctx.ip, 30, 5 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const pre = randomToken(24), challenge = randomToken(32);
    q.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', Date.now());
    q.run('INSERT INTO webauthn_challenges(challenge, kind, binding, expires_at) VALUES (?, ?, ?, ?)', challenge, 'login', sha256(pre), Date.now() + TTL);
    ctx.cookies.push(cookie('pk', pre, { maxAge: TTL, path: '/api/passkeys/login' }));
    return { challenge, rpId: config.rpId, userVerification: 'required', timeout: TTL, allowCredentials: [] };
  });
  r.post('/api/passkeys/login/verify', { auth: 'public' }, ctx => {
    enabled();
    if (!rateLimit('pk-verify:' + ctx.ip, 20, 5 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const pre = ctx.cookieJar.pk;
    if (!pre) fail(400, 'This passkey request expired. Try again.', 'challenge_invalid');
    const cred = ctx.body.credential;
    const challenge = challengeFrom(cred);
    takeChallenge(challenge, 'login', sha256(pre));
    ctx.cookies.push(cookie('pk', '', { maxAge: 0, path: '/api/passkeys/login' }));
    const stored = q.get('SELECT * FROM webauthn_credentials WHERE credential_id = ?', String(cred?.id || ''));
    if (!stored) fail(401, 'This passkey isn’t registered here. Sign in with your password, then add a passkey in Profile.', 'unknown_passkey');
    const user = q.get('SELECT * FROM users WHERE id = ?', stored.user_id);
    if (!user || user.status !== 'active') fail(401, 'This account is not active. Contact your manager.', 'inactive');
    if (cred.response?.userHandle && cred.response.userHandle !== userHandle(user.id)) fail(401, 'This passkey doesn’t match the account.', 'bad_passkey');
    let v;
    try { v = verifyAuthentication(cred, stored, { challenge, origin: config.origin, rpId: config.rpId }); }
    catch (e) {
      if (e instanceof WebAuthnError) { audit(user.id, 'passkey_login_failed', user.id, e.message); fail(401, 'Passkey sign-in failed. Try again or use your password.', 'bad_passkey'); }
      throw e;
    }
    q.run('UPDATE webauthn_credentials SET sign_count = ?, last_used_at = ?, backed_up = ? WHERE id = ?', v.signCount, Date.now(), v.backedUp ? 1 : 0, stored.id);
    // A user-verified passkey proves both the device and the person, so it can satisfy staff two-step sign-in.
    const mfaOk = !staffMfaRequired(user) || setting('passkey_satisfies_mfa') === '1';
    createSession(ctx, user.id, { mfaOk, via: 'passkey' });
    audit(user.id, 'login', user.id, 'passkey');
    return { ok: true, mfa: mfaOk ? null : (user.totp_secret_enc ? 'verify' : 'enroll') };
  });
}
