import { q, tx, allSettings, setSetting } from '../db/index.js';
import { fail } from '../lib/http.js';
import { audit } from '../lib/services.js';
import { str, int, oneOf, username as vUsername, email as vEmail } from '../lib/validate.js';
import { publicUser } from '../lib/access.js';
import { issueLink } from './auth.js';

const ADMIN = { roles: ['admin'] };
const PERMS = ['medical_documents', 'location_history'];
const EDITABLE = {
  staff_mfa_required: v => oneOf(String(v), 'Two-step sign-in', ['0', '1']),
  passkeys_enabled: v => oneOf(String(v), 'Passkeys', ['0', '1']),
  passkey_satisfies_mfa: v => oneOf(String(v), 'Passkey as two-step', ['0', '1']),
  stale_minutes: v => String(int(v, 'Stale after (minutes)')),
  photo_max_age_seconds: v => String(int(v, 'Selfie age limit')),
  location_max_accuracy_m: v => String(int(v, 'Accuracy limit')),
  location_request_minutes: v => String(int(v, 'Location request expiry')),
  photo_retention_days: v => (v === '' || v == null) ? '' : String(int(v, 'Photo retention (days)')),
  invite_hours: v => String(int(v, 'Invitation validity')),
  reset_hours: v => String(int(v, 'Reset link validity'))
};

export default function (r) {
  r.get('/api/admin/teams', ADMIN, () => q.all(`SELECT t.id, t.name, (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.role = 'agent' AND u.status != 'deactivated') agents FROM teams t ORDER BY t.name`));
  r.post('/api/admin/teams', ADMIN, ctx => {
    const res = q.run('INSERT INTO teams(name, created_at) VALUES (?, ?)', str(ctx.body.name, 'Team name', { max: 60 }), Date.now());
    audit(ctx.user.id, 'team_created', res.lastInsertRowid);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  r.get('/api/admin/staff', ADMIN, () => q.all("SELECT * FROM users WHERE role IN ('manager','admin') ORDER BY role, name").map(u => ({
    ...publicUser(u),
    teams: q.all('SELECT team_id FROM manager_teams WHERE user_id = ?', u.id).map(t => t.team_id),
    perms: q.all('SELECT perm FROM permissions WHERE user_id = ?', u.id).map(p => p.perm),
    totp: !!u.totp_secret_enc,
    passkeys: q.get('SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id = ?', u.id).n
  })));
  r.post('/api/admin/staff', ADMIN, ctx => {
    const b = ctx.body, role = oneOf(b.role, 'Role', ['manager', 'admin']);
    const teams = Array.isArray(b.teamIds) ? b.teamIds.map(Number) : [];
    const id = tx(() => {
      const res = q.run(`INSERT INTO users(role, username, name, email, employee_id, mobile, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'invited', ?)`,
        role, vUsername(b.username), str(b.name, 'Name', { max: 100 }), vEmail(b.email), str(b.employeeId, 'Employee ID', { max: 40, optional: true }), str(b.mobile, 'Mobile', { max: 30, optional: true }), Date.now());
      for (const t of teams) { if (!q.get('SELECT 1 FROM teams WHERE id = ?', t)) fail(400, 'Unknown team.'); q.run('INSERT INTO manager_teams(user_id, team_id) VALUES (?, ?)', res.lastInsertRowid, t); }
      return Number(res.lastInsertRowid);
    });
    const link = issueLink(id, 'invite');
    audit(ctx.user.id, 'staff_created', id, { role, teams });
    return { ok: true, id, link: link.url, expiresAt: link.expiresAt, emailed: false };
  });
  r.put('/api/admin/staff/:id', ADMIN, ctx => {
    const u = q.get("SELECT * FROM users WHERE id = ? AND role IN ('manager','admin')", Number(ctx.params.id));
    if (!u) fail(404, 'Not found.');
    const b = ctx.body;
    tx(() => {
      if (Array.isArray(b.teamIds)) {
        q.run('DELETE FROM manager_teams WHERE user_id = ?', u.id);
        for (const t of b.teamIds.map(Number)) { if (!q.get('SELECT 1 FROM teams WHERE id = ?', t)) fail(400, 'Unknown team.'); q.run('INSERT INTO manager_teams(user_id, team_id) VALUES (?, ?)', u.id, t); }
      }
      if (Array.isArray(b.perms)) {
        q.run('DELETE FROM permissions WHERE user_id = ?', u.id);
        for (const p of b.perms) q.run('INSERT INTO permissions(user_id, perm) VALUES (?, ?)', u.id, oneOf(p, 'Permission', PERMS));
      }
      if (typeof b.active === 'boolean') {
        if (!b.active && u.id === ctx.user.id) fail(400, 'You can’t deactivate your own account.');
        q.run('UPDATE users SET status = ? WHERE id = ?', b.active ? (u.password_hash ? 'active' : 'invited') : 'deactivated', u.id);
        if (!b.active) q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      }
    });
    audit(ctx.user.id, 'staff_updated', u.id, { teamIds: b.teamIds, perms: b.perms, active: b.active });
    return { ok: true };
  });
  r.post('/api/admin/users/:id/link', ADMIN, ctx => {
    const u = q.get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u || u.status === 'deactivated') fail(404, 'Not found.');
    const kind = u.status === 'invited' ? 'invite' : 'reset';
    const link = issueLink(u.id, kind);
    audit(ctx.user.id, kind + '_link_issued', u.id);
    return { ok: true, kind, link: link.url, expiresAt: link.expiresAt, emailed: false };
  });
  r.post('/api/admin/users/:id/reset-mfa', ADMIN, ctx => {
    const u = q.get('SELECT * FROM users WHERE id = ?', Number(ctx.params.id));
    if (!u) fail(404, 'Not found.');
    q.run('UPDATE users SET totp_secret_enc = NULL, totp_last_step = 0 WHERE id = ?', u.id);
    q.run('DELETE FROM webauthn_credentials WHERE user_id = ?', u.id);
    q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
    audit(ctx.user.id, 'mfa_reset', u.id);
    return { ok: true };
  });

  r.get('/api/admin/leave-types', ADMIN, () => q.all('SELECT id, name, medical, requires_document requiresDocument, active FROM leave_types ORDER BY id'));
  r.post('/api/admin/leave-types', ADMIN, ctx => {
    const res = q.run('INSERT INTO leave_types(name, medical, requires_document) VALUES (?, ?, ?)', str(ctx.body.name, 'Name', { max: 60 }), ctx.body.medical ? 1 : 0, ctx.body.requiresDocument ? 1 : 0);
    audit(ctx.user.id, 'leave_type_created', res.lastInsertRowid);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });
  r.put('/api/admin/leave-types/:id', ADMIN, ctx => {
    const t = q.get('SELECT * FROM leave_types WHERE id = ?', Number(ctx.params.id));
    if (!t) fail(404, 'Not found.');
    q.run('UPDATE leave_types SET medical = ?, requires_document = ?, active = ? WHERE id = ?',
      ctx.body.medical ?? t.medical ? 1 : 0, ctx.body.requiresDocument ?? t.requires_document ? 1 : 0, ctx.body.active ?? t.active ? 1 : 0, t.id);
    audit(ctx.user.id, 'leave_type_updated', t.id, ctx.body);
    return { ok: true };
  });

  r.get('/api/admin/settings', ADMIN, () => allSettings());
  r.put('/api/admin/settings', ADMIN, ctx => {
    const changed = {};
    for (const [k, v] of Object.entries(ctx.body || {})) {
      if (!EDITABLE[k]) fail(400, `Unknown setting: ${k}`);
      changed[k] = EDITABLE[k](v);
    }
    for (const [k, v] of Object.entries(changed)) setSetting(k, v);
    audit(ctx.user.id, 'settings_changed', null, changed);
    return { ok: true, settings: allSettings() };
  });

  const page = ctx => Math.min(500, Math.max(1, Number(ctx.query.get('limit')) || 200));
  r.get('/api/admin/audit', ADMIN, ctx => q.all(`SELECT a.id, a.action, a.target, a.detail, a.at, u.name actor FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT ?`, page(ctx)));
  r.get('/api/admin/access', ADMIN, ctx => q.all(`SELECT l.id, l.kind, l.ref, l.allowed, l.at, a.name actor, s.name subject FROM access_log l JOIN users a ON a.id = l.actor_id LEFT JOIN users s ON s.id = l.subject_user_id ORDER BY l.id DESC LIMIT ?`, page(ctx)));
}
