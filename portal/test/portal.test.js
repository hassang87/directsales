import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { start, Client, fakeJpeg, dataUrl, SoftAuthenticator, LOC } from './helpers.js';

let env, q, cbor, security, services;
before(async () => {
  env = await start();
  q = env.db.q;
  cbor = await import('../src/lib/cbor.js');
  security = await import('../src/lib/security.js');
  services = await import('../src/lib/services.js');
});
after(() => env.server.close());

const AGENT = ['agent.noor', 'Demo-Agent-2026!'];
const AGENT2 = ['agent.faisal', 'Demo-Agent-2026!'];
const AGENT_SOUTH = ['agent.sara', 'Demo-Agent-2026!'];
const MGR = ['demo.manager', 'Demo-Manager-2026!'];
const MGR_SOUTH = ['demo.manager2', 'Demo-Manager-2026!'];
const uid = username => q.get('SELECT id FROM users WHERE username = ?', username).id;

/** Signs a staff member in (once per test run), enrolling or verifying two-step sign-in. */
const staffCache = new Map();
async function staffClient(creds) {
  if (staffCache.has(creds[0])) return staffCache.get(creds[0]);
  const [u, p] = creds;
  const c = new Client();
  const r = await c.login(u, p);
  assert.equal(r.status, 200);
  const user = q.get('SELECT * FROM users WHERE username = ?', u);
  if (r.data.mfa === 'enroll') {
    const s = await c.post('/api/auth/totp/setup');
    const e = await c.post('/api/auth/totp/enable', { code: security.totpAt(s.data.secret, security.currentStep()) });
    assert.equal(e.status, 200, JSON.stringify(e.data));
  } else if (r.data.mfa === 'verify') {
    const secret = security.unseal(user.totp_secret_enc);
    // Codes can't be reused, so wait for a fresh 30-second step if needed.
    while (security.currentStep() + 1 <= user.totp_last_step) await new Promise(res => setTimeout(res, 1000));
    const st = Math.max(security.currentStep() - 1, user.totp_last_step + 1);
    const v = await c.post('/api/auth/totp/verify', { code: security.totpAt(secret, st) });
    assert.equal(v.status, 200, JSON.stringify(v.data));
  }
  await c.refresh();
  staffCache.set(u, c);
  return c;
}
async function agentClient(creds = AGENT) { const c = new Client(); const r = await c.login(...creds); assert.equal(r.status, 200); return c; }
async function punchIn(c, photo = fakeJpeg()) {
  const s = await c.post('/api/punch/start');
  assert.equal(s.status, 200, JSON.stringify(s.data));
  return { sub: s.data.submissionId, res: await c.post('/api/punch/in', { submissionId: s.data.submissionId, ...LOC, capturedAt: Date.now(), photo: dataUrl(photo) }), photo };
}

test('sign-in: wrong password, CSRF and origin checks', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/session')).data.user, null);
  assert.equal((await c.post('/api/auth/login', { username: 'agent.noor', password: 'wrong-password' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { username: AGENT[0], password: AGENT[1] }, { origin: 'https://evil.example' })).status, 403);
  await c.login(...AGENT);
  assert.equal((await c.post('/api/punch/start', {}, { csrf: false })).status, 403, 'state change without CSRF token is refused');
  assert.equal((await c.get('/api/me/home')).status, 200);
});

test('punch-in needs a fresh location and a complete camera JPEG; failures leave nothing behind', async () => {
  const c = await agentClient();
  const filesBefore = fs.readdirSync(env.config.filesDir).length;
  const s = await c.post('/api/punch/start');
  const base = { submissionId: s.data.submissionId, capturedAt: Date.now() };
  assert.equal((await c.post('/api/punch/in', { ...base, photo: dataUrl(fakeJpeg()) })).data.code, 'location_required');
  const truncated = fakeJpeg().subarray(0, 100);
  assert.equal((await c.post('/api/punch/in', { ...base, ...LOC, photo: dataUrl(truncated) })).data.code, 'photo_incomplete');
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex');
  assert.equal((await c.post('/api/punch/in', { ...base, ...LOC, photo: dataUrl(png, 'image/jpeg') })).data.code, 'photo_incomplete');
  assert.equal((await c.post('/api/punch/in', { ...base, ...LOC, capturedAt: Date.now() - 3600e3, photo: dataUrl(fakeJpeg()) })).data.code, 'photo_stale');
  assert.equal(q.get('SELECT COUNT(*) n FROM attendance WHERE user_id = ?', uid('agent.noor')).n, 0);
  assert.equal(fs.readdirSync(env.config.filesDir).length, filesBefore, 'no orphaned files');
});

test('punch-in, retry, replay, double punch-in, photo reuse and punch-out', async () => {
  const c = await agentClient();
  const { sub, res, photo } = await punchIn(c);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.attendance.kind, 'standard');
  // A retry of the same submission returns the saved record and never creates a second one.
  const retry = await c.post('/api/punch/in', { submissionId: sub, ...LOC, capturedAt: Date.now(), photo: dataUrl(photo) });
  assert.equal(retry.data.alreadySaved, true);
  assert.equal(q.get('SELECT COUNT(*) n FROM attendance WHERE user_id = ?', uid('agent.noor')).n, 1);
  assert.equal((await c.post('/api/punch/start')).data.code, 'already_on_duty');
  // The database itself refuses a second open session.
  assert.throws(() => q.run("INSERT INTO attendance(user_id, kind, punch_in_at, created_at) VALUES (?, 'standard', ?, ?)", uid('agent.noor'), Date.now(), Date.now()), /UNIQUE/);
  // Concurrent punch-ins: only one wins.
  const out = await c.post('/api/punch/out', LOC);
  assert.equal(out.status, 200);
  assert.ok(out.data.attendance.punchOutAt >= out.data.attendance.punchInAt);
  assert.equal((await c.post('/api/punch/out', LOC)).data.code, 'not_on_duty');
  const again = await punchIn(c, photo);
  assert.equal(again.res.data.code, 'photo_reused');
  const [a, b] = await Promise.all([punchIn(c), punchIn(c).catch(e => ({ res: { status: 0, err: e } }))]);
  const ok = [a.res.status, b.res.status].filter(x => x === 200).length;
  assert.ok(ok >= 1);
  assert.equal(q.get('SELECT COUNT(*) n FROM attendance WHERE user_id = ? AND punch_out_at IS NULL', uid('agent.noor')).n, 1);
  await c.post('/api/punch/out', LOC);
});

test('camera-denied exception is stored separately and reviewed by the manager', async () => {
  const c = await agentClient(AGENT2);
  // Faisal has a synthetic open session from the demo seed; close it first.
  await c.post('/api/punch/out', LOC);
  const s = await c.post('/api/punch/start');
  const r = await c.post('/api/punch/exception', { submissionId: s.data.submissionId, reason: 'Camera not working', note: 'Black screen' });
  assert.equal(r.status, 200);
  assert.equal(r.data.attendance.kind, 'exception');
  assert.equal(r.data.attendance.excStatus, 'pending');
  const m = await staffClient(MGR);
  assert.equal((await m.post(`/api/team/attendance/${r.data.attendance.id}/decide`, { decision: 'rejected' })).data.code, 'comment_required');
  assert.equal((await m.post(`/api/team/attendance/${r.data.attendance.id}/decide`, { decision: 'approved' })).status, 200);
  assert.equal(q.get('SELECT kind FROM attendance WHERE id = ?', r.data.attendance.id).kind, 'exception', 'stays an exception after approval');
  await c.post('/api/punch/out', LOC);
});

test('punch-in photos: owner and same-team manager only; every view is logged', async () => {
  const c = await agentClient();
  const { res } = await punchIn(c);
  const id = res.data.attendance.id;
  const own = await c.get(`/api/attendance/${id}/photo`, { raw: true });
  assert.equal(own.status, 200); assert.equal(own.headers.get('content-type'), 'image/jpeg'); assert.match(own.headers.get('cache-control'), /no-store/);
  const other = await agentClient(AGENT2);
  assert.equal((await other.get(`/api/attendance/${id}/photo`, { raw: true })).status, 404);
  const m = await staffClient(MGR);
  assert.equal((await m.get(`/api/attendance/${id}/photo`, { raw: true })).status, 200);
  const m2 = await staffClient(MGR_SOUTH);
  assert.equal((await m2.get(`/api/attendance/${id}/photo`, { raw: true })).status, 404, 'other team cannot see it');
  assert.equal((await m2.get('/api/team/agents')).data.some(a => a.username === 'agent.noor'), false);
  const log = q.all("SELECT allowed FROM access_log WHERE kind = 'punch_photo' AND ref = ?", String(id)).map(r => r.allowed);
  assert.deepEqual(log.sort(), [0, 0, 1, 1]);
  await c.post('/api/punch/out', LOC);
});

test('staff need two-step sign-in; codes cannot be reused', async () => {
  const c = new Client();
  const r = await c.login(...MGR_SOUTH);
  assert.ok(['enroll', 'verify'].includes(r.data.mfa));
  assert.equal((await c.get('/api/team/agents')).data.code, 'mfa_required');
  await staffClient(MGR_SOUTH);
  const u = q.get("SELECT * FROM users WHERE username = 'demo.manager2'");
  const c2 = new Client(); await c2.login(...MGR_SOUTH);
  const reused = security.totpAt(security.unseal(u.totp_secret_enc), u.totp_last_step);
  assert.equal((await c2.post('/api/auth/totp/verify', { code: reused })).data.code, 'bad_code');
});

test('passkeys: add, sign in, and the checks that protect them', async () => {
  const c = await agentClient(AGENT_SOUTH);
  const auth = new SoftAuthenticator();
  const opts = await c.post('/api/passkeys/register/options');
  assert.equal(opts.data.authenticatorSelection.userVerification, 'required');
  const reg = await c.post('/api/passkeys/register/verify', { label: 'Test phone', credential: await auth.create(opts.data, env.origin, { cbor }) });
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  assert.equal(reg.data.passkeys.length, 1);

  const fresh = new Client();
  const lo = await fresh.post('/api/passkeys/login/options');
  const handle = Buffer.from(`dsp-user-${uid('agent.sara')}`).toString('base64url');
  const v = await fresh.post('/api/passkeys/login/verify', { credential: auth.get(lo.data, env.origin, { userHandle: handle }) });
  assert.equal(v.status, 200, JSON.stringify(v.data));
  const s = await fresh.refresh();
  assert.equal(s.user.username, 'agent.sara'); assert.equal(s.via, 'passkey');
  // The same challenge cannot be used twice.
  assert.equal((await fresh.post('/api/passkeys/login/verify', { credential: auth.get(lo.data, env.origin) })).status, 400);
  // Wrong origin (phishing site) is refused.
  const evil = new Client(); const lo2 = await evil.post('/api/passkeys/login/options');
  assert.equal((await evil.post('/api/passkeys/login/verify', { credential: auth.get(lo2.data, 'https://evil.example') })).status, 401);
  // Without Face ID / fingerprint (UV flag) it is refused.
  const nouv = new Client(); const lo3 = await nouv.post('/api/passkeys/login/options');
  assert.equal((await nouv.post('/api/passkeys/login/verify', { credential: auth.get(lo3.data, env.origin, { flags: 0x01 }) })).status, 401);
  // Removing it stops it working.
  const pid = reg.data.passkeys[0].id;
  assert.equal((await c.del(`/api/passkeys/${pid}`)).status, 200);
  const gone = new Client(); const lo4 = await gone.post('/api/passkeys/login/options');
  assert.equal((await gone.post('/api/passkeys/login/verify', { credential: auth.get(lo4.data, env.origin) })).data.code, 'unknown_passkey');
});

test('a manager’s passkey counts as two-step sign-in', async () => {
  const m = await staffClient(MGR);
  const auth = new SoftAuthenticator();
  const o = await m.post('/api/passkeys/register/options');
  assert.equal((await m.post('/api/passkeys/register/verify', { credential: await auth.create(o.data, env.origin, { cbor }) })).status, 200);
  const c = new Client();
  const lo = await c.post('/api/passkeys/login/options');
  const r = await c.post('/api/passkeys/login/verify', { credential: auth.get(lo.data, env.origin) });
  assert.equal(r.data.mfa, null);
  await c.refresh();
  assert.equal((await c.get('/api/team/agents')).status, 200);
});

test('leave: documents are checked by content; medical files need the explicit permission', async () => {
  const c = await agentClient();
  const types = (await c.get('/api/leave/types')).data;
  const sick = types.find(t => t.name === 'Sick'), annual = types.find(t => t.name === 'Annual');
  const base = { typeId: sick.id, start: '2030-01-05', end: '2030-01-05' };
  assert.equal((await c.post('/api/leave', base)).data.code, 'document_required');
  const evilPdf = Buffer.from('%PDF-1.4\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\n%%EOF');
  assert.equal((await c.post('/api/leave', { ...base, document: dataUrl(evilPdf, 'application/pdf') })).data.code, 'unsafe_pdf');
  assert.equal((await c.post('/api/leave', { ...base, document: dataUrl(Buffer.from('MZ fake exe'), 'application/pdf') })).data.code, 'bad_document');
  const okPdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF');
  const r = await c.post('/api/leave', { ...base, document: dataUrl(okPdf, 'application/pdf') });
  assert.equal(r.status, 200);
  const m = await staffClient(MGR);
  const doc = await m.get(`/api/leave/${r.data.id}/document`);
  assert.equal(doc.status, 403);
  assert.equal(q.get("SELECT allowed FROM access_log WHERE kind = 'medical_document' ORDER BY id DESC LIMIT 1").allowed, 0);
  q.run("INSERT INTO permissions(user_id, perm) VALUES (?, 'medical_documents')", uid('demo.manager'));
  assert.equal((await m.get(`/api/leave/${r.data.id}/document`, { raw: true })).status, 200);
  // Decisions notify without revealing the type.
  assert.equal((await m.post(`/api/team/leave/${r.data.id}/decide`, { decision: 'approved' })).status, 200);
  const n = q.get('SELECT text FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 1', uid('agent.noor')).text;
  assert.doesNotMatch(n, /sick|medical/i);
  const sched = await c.get('/api/me/schedule?from=2030-01-01&to=2030-01-10');
  assert.equal(sched.data.leave[0].status, 'approved');
  const half = await c.post('/api/leave', { typeId: annual.id, start: '2030-02-01', end: '2030-02-03', portion: 'morning' });
  assert.equal(half.status, 400);
});

test('location requests only reach on-duty agents, and sharing answers them', async () => {
  const m = await staffClient(MGR);
  const noor = uid('agent.noor');
  const off = await m.post('/api/team/location-requests', { userIds: [noor], reason: 'Check' });
  assert.equal(off.data.sent.length, 0); assert.equal(off.data.skipped[0].why, 'off duty');
  const c = await agentClient();
  await punchIn(c);
  const on = await m.post('/api/team/location-requests', { userIds: [noor], reason: 'Check' });
  assert.equal(on.data.sent.length, 1);
  assert.ok((await c.get('/api/me/home')).data.locationRequest);
  assert.equal((await c.post('/api/location/share', LOC)).data.answeredRequests, 1);
  const agents = (await m.get('/api/team/agents')).data;
  const a = agents.find(x => x.id === noor);
  assert.ok(a.lastLocation && Date.now() - a.lastLocation.at < 60e3);
  assert.equal(agents.find(x => x.username === 'agent.mariam').lastLocation, null, 'off-duty agents expose no location');
  await c.post('/api/punch/out', LOC);
  assert.equal((await c.post('/api/location/share', LOC)).data.code, 'off_duty');
});

test('schedules are invisible to agents until published', async () => {
  const m = await staffClient(MGR);
  const noor = uid('agent.noor');
  assert.equal((await m.put('/api/team/schedule', { entries: [{ userId: noor, date: '2031-03-01', kind: 'shift', start: '22:00', end: '06:00' }] })).status, 200);
  const c = await agentClient();
  assert.equal((await c.get('/api/me/schedule?from=2031-03-01&to=2031-03-02')).data.shifts.length, 0);
  assert.equal((await m.post('/api/team/schedule/publish', { from: '2031-03-01', to: '2031-03-01' })).data.published, 1);
  const s = (await c.get('/api/me/schedule?from=2031-03-01&to=2031-03-02')).data.shifts;
  assert.equal(s.length, 1); assert.equal(s[0].end, '06:00');
  const south = await staffClient(MGR_SOUTH);
  assert.equal((await south.put('/api/team/schedule', { entries: [{ userId: noor, date: '2031-03-02', kind: 'off' }] })).status, 404, 'cannot edit another team');
});

test('invitations are single-use and expire; deactivation is immediate', async () => {
  const m = await staffClient(MGR);
  const teamId = q.get("SELECT id FROM teams WHERE name = 'Team North'").id;
  const created = await m.post('/api/team/agents', { name: 'Test Agent', username: 'agent.test', teamId });
  assert.equal(created.status, 200);
  const token = created.data.link.split('/link/')[1];
  const anon = new Client();
  assert.equal((await anon.get(`/api/auth/link/${token}`)).data.username, 'agent.test');
  assert.equal((await anon.post(`/api/auth/link/${token}`, { password: 'password123' })).status, 400);
  assert.equal((await anon.post(`/api/auth/link/${token}`, { password: 'Field-Team-2026' })).status, 200);
  assert.equal((await anon.post(`/api/auth/link/${token}`, { password: 'Field-Team-2026' })).status, 410);
  // A resent link revokes the older one.
  const l1 = await m.post(`/api/team/agents/${created.data.id}/link`); const l2 = await m.post(`/api/team/agents/${created.data.id}/link`);
  assert.equal((await anon.get(`/api/auth/link/${l1.data.link.split('/link/')[1]}`)).status, 410);
  assert.equal((await anon.get(`/api/auth/link/${l2.data.link.split('/link/')[1]}`)).status, 200);
  q.run("UPDATE tokens SET expires_at = ? WHERE token_hash = ?", Date.now() - 1, security.sha256(l2.data.link.split('/link/')[1]));
  assert.equal((await anon.get(`/api/auth/link/${l2.data.link.split('/link/')[1]}`)).status, 410);

  const a = await agentClient(['agent.test', 'Field-Team-2026']);
  assert.equal((await a.get('/api/me/home')).status, 200);
  assert.equal((await m.post(`/api/team/agents/${created.data.id}/status`, { active: false })).status, 200);
  assert.equal((await a.get('/api/me/home')).status, 401, 'signed out on the next request');
  assert.equal((await new Client().post('/api/auth/login', { username: 'agent.test', password: 'Field-Team-2026' })).status, 401);
});

test('roles: agents cannot reach manager or admin routes', async () => {
  const c = await agentClient();
  assert.equal((await c.get('/api/team/agents')).status, 403);
  assert.equal((await c.get('/api/admin/settings')).status, 403);
  const m = await staffClient(MGR);
  assert.equal((await m.get('/api/admin/settings')).status, 403);
  assert.equal((await m.get('/api/me/home')).status, 403);
});

test('rate limits and lockout', async () => {
  services.resetRateLimits();
  const c = new Client();
  let last;
  for (let i = 0; i < 11; i++) last = await c.post('/api/auth/login', { username: 'agent.mariam', password: 'nope-' + i });
  assert.ok([423, 429].includes(last.status), `got ${last.status}`);
  q.run("UPDATE users SET locked_until = 0, failed_logins = 0 WHERE username = 'agent.mariam'");
  services.resetRateLimits();
});

test('data survives a restart and sessions still work', async () => {
  const c = await agentClient();
  const before = (await c.get('/api/me/attendance')).data.length;
  env.db.closeDb(); env.db.openDb();
  assert.equal((await c.get('/api/me/attendance')).data.length, before);
});

test('the punch-in code has no file picker, gallery, paste or drop path', () => {
  const src = fs.readFileSync(new URL('../public/js/punch.js', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, ''); // ignore comments
  for (const bad of [/type:\s*['"]file['"]/, /<input[^>]+file/i, /FileReader/, /\bpaste\b/, /\bdrop\b/, /dataTransfer/, /showOpenFilePicker/, /capture=/]) assert.doesNotMatch(src, bad);
  assert.match(src, /getUserMedia/);
});
