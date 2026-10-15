import { q, tx, settingNum } from '../db/index.js';
import { fail } from '../lib/http.js';
import { audit, access, notify, rateLimit } from '../lib/services.js';
import { bhDate, bhToUtc, addDays, isDate, isTime, shiftWindow } from '../lib/time.js';
import { str, int, oneOf, username as vUsername, email as vEmail } from '../lib/validate.js';
import { managedTeamIds, managedAgent, teamScope, hasPerm } from '../lib/access.js';
import { attendanceRow, expireLocationRequests } from './agent.js';
import { issueLink } from './auth.js';

const STAFF = { roles: ['manager', 'admin'] };

/** Teams in view: one requested team (if managed) or every managed team. */
function scopeTeams(ctx) {
  const ids = managedTeamIds(ctx.user);
  const t = ctx.query.get('teamId') || ctx.body?.teamId;
  if (t) { const n = Number(t); if (!ids.includes(n)) fail(404, 'Team not found.'); return [n]; }
  return ids;
}
const inList = ids => ids.length ? ids.map(() => '?').join(',') : 'NULL';
function agentsIn(teamIds, { activeOnly = false } = {}) {
  return q.all(`SELECT u.*, t.name team FROM users u JOIN teams t ON t.id = u.team_id WHERE u.role = 'agent' AND u.team_id IN (${inList(teamIds)}) ${activeOnly ? "AND u.status = 'active'" : ''} ORDER BY u.name`, ...teamIds);
}

export default function (r) {
  r.get('/api/team/teams', STAFF, ctx => {
    const ids = managedTeamIds(ctx.user);
    return q.all(`SELECT id, name FROM teams WHERE id IN (${inList(ids)}) ORDER BY name`, ...ids);
  });

  r.get('/api/team/overview', STAFF, ctx => {
    expireLocationRequests();
    const teams = scopeTeams(ctx), date = isDate(ctx.query.get('date')) ? ctx.query.get('date') : bhDate();
    const agents = agentsIn(teams, { activeOnly: true });
    const ids = agents.map(a => a.id), ph = inList(ids);
    const dayStart = bhToUtc(date), dayEnd = bhToUtc(addDays(date, 1));
    const shifts = q.all(`SELECT * FROM shifts WHERE published = 1 AND date = ? AND user_id IN (${ph})`, date, ...ids);
    const att = q.all(`SELECT * FROM attendance WHERE user_id IN (${ph}) AND punch_in_at >= ? AND punch_in_at < ?`, ...ids, dayStart, dayEnd);
    const open = q.all(`SELECT * FROM attendance WHERE user_id IN (${ph}) AND punch_out_at IS NULL`, ...ids);
    const onLeave = q.all(`SELECT DISTINCT user_id FROM leave_requests WHERE status = 'approved' AND start_date <= ? AND end_date >= ? AND user_id IN (${ph})`, date, date, ...ids).map(x => x.user_id);
    const staleMs = settingNum('stale_minutes') * 60e3, now = Date.now();
    const lastLoc = id => q.get('SELECT at FROM locations WHERE user_id = ? ORDER BY at DESC LIMIT 1', id);
    const scheduled = shifts.filter(s => s.kind === 'shift' && !onLeave.includes(s.user_id));
    const noPunch = scheduled.filter(s => !att.some(a => a.user_id === s.user_id) && date <= bhDate() && (date < bhDate() || shiftWindow(s.date, s.start_time, s.end_time)[0] < now));
    const stale = open.filter(a => { const l = lastLoc(a.user_id); return !l || now - l.at > staleMs; });
    const name = id => agents.find(a => a.id === id)?.name;
    return {
      date,
      counts: {
        scheduled: scheduled.length,
        punchedIn: new Set(att.map(a => a.user_id)).size,
        onDuty: open.length,
        punchedOut: att.filter(a => a.punch_out_at).length,
        noPunchRecorded: noPunch.length,
        off: shifts.filter(s => s.kind === 'off').length,
        onLeave: onLeave.length,
        pendingLeave: q.get(`SELECT COUNT(*) n FROM leave_requests WHERE status = 'pending' AND user_id IN (${ph})`, ...ids).n,
        pendingExceptions: q.get(`SELECT COUNT(*) n FROM attendance WHERE exc_status = 'pending' AND user_id IN (${ph})`, ...ids).n,
        pendingLocationRequests: q.get(`SELECT COUNT(*) n FROM location_requests WHERE status = 'pending' AND user_id IN (${ph})`, ...ids).n,
        staleLocations: stale.length
      },
      noPunch: noPunch.map(s => ({ userId: s.user_id, name: name(s.user_id), start: s.start_time })),
      stale: stale.map(a => ({ userId: a.user_id, name: name(a.user_id), lastAt: lastLoc(a.user_id)?.at ?? null }))
    };
  });

  /* Agents with today's status. Latest location is only returned for agents who are on duty. */
  r.get('/api/team/agents', STAFF, ctx => {
    expireLocationRequests();
    const today = bhDate();
    return agentsIn(scopeTeams(ctx)).map(a => {
      const open = q.get('SELECT * FROM attendance WHERE user_id = ? AND punch_out_at IS NULL', a.id);
      const shift = q.get('SELECT s.*, w.name wl FROM shifts s LEFT JOIN work_locations w ON w.id = s.work_location_id WHERE s.user_id = ? AND s.date = ? AND s.published = 1', a.id, today);
      const loc = open ? q.get('SELECT lat, lng, acc, source, at FROM locations WHERE user_id = ? AND at >= ? ORDER BY at DESC LIMIT 1', a.id, open.punch_in_at) : null;
      return {
        id: a.id, name: a.name, username: a.username, employeeId: a.employee_id, mobile: a.mobile, email: a.email, teamId: a.team_id, team: a.team, status: a.status,
        passkeys: q.get('SELECT COUNT(*) n FROM webauthn_credentials WHERE user_id = ?', a.id).n,
        shift: shift ? { kind: shift.kind, start: shift.start_time, end: shift.end_time, location: shift.wl } : null,
        open: attendanceRow(open), lastLocation: loc || null,
        pendingRequest: !!q.get("SELECT 1 FROM location_requests WHERE user_id = ? AND status = 'pending'", a.id)
      };
    });
  });

  r.get('/api/team/attendance', STAFF, ctx => {
    const teams = scopeTeams(ctx), date = isDate(ctx.query.get('date')) ? ctx.query.get('date') : bhDate();
    const pendingOnly = ctx.query.get('pending') === '1';
    const rows = q.all(`SELECT a.*, u.name agent, u.team_id FROM attendance a JOIN users u ON u.id = a.user_id
                        WHERE u.team_id IN (${inList(teams)}) AND ${pendingOnly ? "a.exc_status = 'pending'" : 'a.punch_in_at >= ? AND a.punch_in_at < ?'}
                        ORDER BY a.punch_in_at DESC LIMIT 300`, ...teams, ...(pendingOnly ? [] : [bhToUtc(date), bhToUtc(addDays(date, 1))]));
    return rows.map(a => ({ ...attendanceRow(a), userId: a.user_id, agent: a.agent }));
  });

  r.post('/api/team/attendance/:id/decide', STAFF, ctx => {
    const a = q.get('SELECT * FROM attendance WHERE id = ?', Number(ctx.params.id));
    if (!a) fail(404, 'Not found.');
    managedAgent(ctx.user, a.user_id);
    if (a.exc_status !== 'pending') fail(409, 'This exception was already decided.', 'decided');
    const decision = oneOf(ctx.body.decision, 'Decision', ['approved', 'rejected']);
    const comment = str(ctx.body.comment, 'Comment', { max: 500, optional: true });
    if (decision === 'rejected' && !comment) fail(400, 'Add a comment so the agent knows why.', 'comment_required');
    q.run('UPDATE attendance SET exc_status = ?, exc_decided_by = ?, exc_comment = ? WHERE id = ?', decision, ctx.user.id, comment, a.id);
    notify(a.user_id, 'Your attendance exception was reviewed.', '#/attendance');
    audit(ctx.user.id, 'exception_' + decision, a.id, comment);
    return { ok: true };
  });

  /* ----- leave decisions ----- */
  r.get('/api/team/leave', STAFF, ctx => {
    const teams = scopeTeams(ctx), status = ctx.query.get('status') || 'pending';
    const rows = q.all(`SELECT l.*, t.name type, t.medical, u.name agent, u.team_id FROM leave_requests l JOIN leave_types t ON t.id = l.type_id JOIN users u ON u.id = l.user_id
                        WHERE u.team_id IN (${inList(teams)}) ${status === 'all' ? '' : 'AND l.status = ?'} ORDER BY l.created_at DESC LIMIT 200`, ...teams, ...(status === 'all' ? [] : [status]));
    return rows.map(l => ({
      id: l.id, userId: l.user_id, agent: l.agent, type: l.type, medical: !!l.medical, start: l.start_date, end: l.end_date, portion: l.portion,
      comment: l.comment, status: l.status, decisionComment: l.decision_comment, hasDocument: !!l.doc_file, createdAt: l.created_at,
      // Availability only: how many teammates are already off on overlapping days.
      overlap: q.get(`SELECT COUNT(DISTINCT x.user_id) n FROM leave_requests x JOIN users v ON v.id = x.user_id WHERE v.team_id = ? AND x.user_id != ? AND x.status = 'approved' AND x.start_date <= ? AND x.end_date >= ?`, l.team_id, l.user_id, l.end_date, l.start_date).n
    }));
  });
  r.post('/api/team/leave/:id/decide', STAFF, ctx => {
    const l = q.get('SELECT * FROM leave_requests WHERE id = ?', Number(ctx.params.id));
    if (!l) fail(404, 'Not found.');
    managedAgent(ctx.user, l.user_id);
    if (l.status !== 'pending') fail(409, 'This request was already decided.', 'decided');
    const decision = oneOf(ctx.body.decision, 'Decision', ['approved', 'rejected']);
    const comment = str(ctx.body.comment, 'Comment', { max: 500, optional: true });
    if (decision === 'rejected' && !comment) fail(400, 'A comment is required to reject.', 'comment_required');
    q.run('UPDATE leave_requests SET status = ?, decided_by = ?, decision_comment = ?, decided_at = ? WHERE id = ?', decision, ctx.user.id, comment, Date.now(), l.id);
    notify(l.user_id, decision === 'approved' ? 'Your leave request was approved.' : 'Your leave request was declined. Open Leave to see the comment.', '#/leave');
    audit(ctx.user.id, 'leave_' + decision, l.id, comment);
    return { ok: true };
  });

  /* ----- location requests (on-duty agents only) ----- */
  r.post('/api/team/location-requests', STAFF, ctx => {
    if (!rateLimit('locreq:' + ctx.user.id, 60, 10 * 60e3)) fail(429, 'Too many requests. Wait a few minutes.', 'rate_limited');
    const reason = str(ctx.body.reason, 'Reason', { max: 200 });
    const ids = Array.isArray(ctx.body.userIds) ? ctx.body.userIds.slice(0, 100).map(Number) : [];
    if (!ids.length) fail(400, 'Choose at least one agent.');
    expireLocationRequests();
    const sent = [], skipped = [];
    for (const id of ids) {
      let a; try { a = managedAgent(ctx.user, id); } catch { skipped.push({ userId: id, why: 'not in your teams' }); continue; }
      if (!q.get('SELECT 1 FROM attendance WHERE user_id = ? AND punch_out_at IS NULL', id)) { skipped.push({ userId: id, name: a.name, why: 'off duty' }); continue; }
      if (q.get("SELECT 1 FROM location_requests WHERE user_id = ? AND status = 'pending'", id)) { skipped.push({ userId: id, name: a.name, why: 'already asked' }); continue; }
      const res = q.run("INSERT INTO location_requests(manager_id, user_id, reason, status, created_at) VALUES (?, ?, ?, 'pending', ?)", ctx.user.id, id, reason, Date.now());
      notify(id, `${ctx.user.name} asked for your current location.`, '#/home');
      audit(ctx.user.id, 'location_requested', id, reason);
      sent.push({ id: Number(res.lastInsertRowid), userId: id, name: a.name });
    }
    return { sent, skipped };
  });
  r.get('/api/team/location-requests', STAFF, ctx => {
    expireLocationRequests();
    const teams = scopeTeams(ctx);
    return q.all(`SELECT r.id, r.user_id userId, u.name agent, m.name manager, r.reason, r.status, r.created_at createdAt, r.answered_at answeredAt
                  FROM location_requests r JOIN users u ON u.id = r.user_id JOIN users m ON m.id = r.manager_id
                  WHERE u.team_id IN (${inList(teams)}) ORDER BY r.created_at DESC LIMIT 50`, ...teams);
  });
  r.get('/api/team/agents/:id/locations', STAFF, ctx => {
    const a = managedAgent(ctx.user, ctx.params.id);
    const allowed = hasPerm(ctx.user, 'location_history');
    access(ctx.user.id, 'location_history', a.id, null, allowed);
    if (!allowed) fail(403, 'You need the location history permission to see past locations.', 'forbidden');
    return q.all('SELECT lat, lng, acc, source, at FROM locations WHERE user_id = ? ORDER BY at DESC LIMIT 200', a.id);
  });

  /* ----- schedules: draft, then publish ----- */
  r.get('/api/team/schedule', STAFF, ctx => {
    const teams = scopeTeams(ctx);
    const from = isDate(ctx.query.get('from')) ? ctx.query.get('from') : bhDate();
    const to = isDate(ctx.query.get('to')) ? ctx.query.get('to') : addDays(from, 6);
    const agents = agentsIn(teams).filter(a => a.status !== 'deactivated');
    const ids = agents.map(a => a.id);
    return {
      from, to,
      agents: agents.map(a => ({ id: a.id, name: a.name, teamId: a.team_id })),
      shifts: q.all(`SELECT user_id userId, date, kind, start_time start, end_time end, work_location_id workLocationId, published FROM shifts WHERE date BETWEEN ? AND ? AND user_id IN (${inList(ids)})`, from, to, ...ids),
      leave: q.all(`SELECT user_id userId, start_date start, end_date end, status FROM leave_requests WHERE status IN ('approved','pending') AND end_date >= ? AND start_date <= ? AND user_id IN (${inList(ids)})`, from, to, ...ids),
      workLocations: q.all(`SELECT id, team_id teamId, name, lat, lng FROM work_locations WHERE team_id IN (${inList(teams)}) ORDER BY name`, ...teams)
    };
  });
  r.put('/api/team/schedule', { ...STAFF, bodyLimit: 512 * 1024 }, ctx => {
    const entries = Array.isArray(ctx.body.entries) ? ctx.body.entries : [];
    if (!entries.length || entries.length > 2000) fail(400, 'Send between 1 and 2000 entries.');
    const teams = managedTeamIds(ctx.user);
    tx(() => {
      for (const e of entries) {
        const a = managedAgent(ctx.user, e.userId);
        if (!isDate(e.date)) fail(400, 'Each entry needs a valid date.');
        if (e.kind === 'clear') { q.run('DELETE FROM shifts WHERE user_id = ? AND date = ?', a.id, e.date); continue; }
        const kind = oneOf(e.kind, 'Kind', ['shift', 'off']);
        let start = null, end = null, wl = null;
        if (kind === 'shift') {
          if (!isTime(e.start) || !isTime(e.end)) fail(400, `Shift times for ${a.name} on ${e.date} must be HH:MM.`);
          start = e.start; end = e.end;
          if (e.workLocationId) {
            const w = q.get('SELECT * FROM work_locations WHERE id = ?', Number(e.workLocationId));
            if (!w || !teams.includes(w.team_id)) fail(400, 'Unknown work location.');
            wl = w.id;
          }
        }
        q.run(`INSERT INTO shifts(user_id, date, kind, start_time, end_time, work_location_id, published, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
               ON CONFLICT(user_id, date) DO UPDATE SET kind = excluded.kind, start_time = excluded.start_time, end_time = excluded.end_time,
               work_location_id = excluded.work_location_id, published = 0, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          a.id, e.date, kind, start, end, wl, ctx.user.id, Date.now());
      }
    });
    audit(ctx.user.id, 'schedule_drafted', null, { count: entries.length });
    return { ok: true };
  });
  r.post('/api/team/schedule/publish', STAFF, ctx => {
    const teams = scopeTeams(ctx);
    if (!isDate(ctx.body.from) || !isDate(ctx.body.to)) fail(400, 'Choose the dates to publish.');
    const drafts = q.all(`SELECT s.* FROM shifts s JOIN users u ON u.id = s.user_id WHERE s.published = 0 AND s.date BETWEEN ? AND ? AND u.team_id IN (${inList(teams)})`, ctx.body.from, ctx.body.to, ...teams);
    tx(() => { for (const s of drafts) q.run('UPDATE shifts SET published = 1 WHERE id = ?', s.id); });
    for (const uid of new Set(drafts.map(s => s.user_id))) notify(uid, 'Your schedule was updated. Open Schedule to see it.', '#/schedule');
    audit(ctx.user.id, 'schedule_published', null, { from: ctx.body.from, to: ctx.body.to, entries: drafts.length });
    return { ok: true, published: drafts.length };
  });

  r.get('/api/team/work-locations', STAFF, ctx => { const t = scopeTeams(ctx); return q.all(`SELECT id, team_id teamId, name, lat, lng FROM work_locations WHERE team_id IN (${inList(t)}) ORDER BY name`, ...t); });
  r.post('/api/team/work-locations', STAFF, ctx => {
    const teamId = int(ctx.body.teamId, 'Team');
    if (!managedTeamIds(ctx.user).includes(teamId)) fail(404, 'Team not found.');
    const lat = Number(ctx.body.lat), lng = Number(ctx.body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) fail(400, 'Enter valid coordinates.');
    const res = q.run('INSERT INTO work_locations(team_id, name, lat, lng) VALUES (?, ?, ?, ?)', teamId, str(ctx.body.name, 'Name', { max: 80 }), lat, lng);
    audit(ctx.user.id, 'work_location_created', res.lastInsertRowid);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  /* ----- announcements ----- */
  r.get('/api/team/announcements', STAFF, ctx => {
    const teams = managedTeamIds(ctx.user);
    return q.all(`SELECT a.*, u.name author, t.name team FROM announcements a JOIN users u ON u.id = a.created_by LEFT JOIN teams t ON t.id = a.team_id
                  WHERE a.team_id IS NULL OR a.team_id IN (${inList(teams)}) ORDER BY a.pinned DESC, a.created_at DESC LIMIT 100`, ...teams)
      .map(a => {
        const audience = a.team_id ? [a.team_id] : teams;
        const total = q.get(`SELECT COUNT(*) n FROM users WHERE role = 'agent' AND status = 'active' AND team_id IN (${inList(audience)})`, ...audience).n;
        const acked = q.get(`SELECT COUNT(*) n FROM announcement_acks k JOIN users u ON u.id = k.user_id WHERE k.announcement_id = ? AND u.team_id IN (${inList(audience)})`, a.id, ...audience).n;
        return { id: a.id, title: a.title, body: a.body, priority: a.priority, pinned: !!a.pinned, requiresAck: !!a.requires_ack, team: a.team || 'Everyone', author: a.author, createdAt: a.created_at, expiresAt: a.expires_at, acked, total };
      });
  });
  r.post('/api/team/announcements', STAFF, ctx => {
    const b = ctx.body;
    let teamId = b.teamId == null || b.teamId === '' ? null : int(b.teamId, 'Team');
    if (teamId === null && ctx.user.role !== 'admin') fail(403, 'Only administrators can post to everyone. Choose a team.');
    if (teamId !== null && !managedTeamIds(ctx.user).includes(teamId)) fail(404, 'Team not found.');
    const days = b.expiresDays ? int(b.expiresDays, 'Expiry') : null;
    const res = q.run('INSERT INTO announcements(title, body, priority, pinned, team_id, requires_ack, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      str(b.title, 'Title', { max: 120 }), str(b.body, 'Message', { max: 4000 }), oneOf(b.priority || 'normal', 'Priority', ['normal', 'high']),
      b.pinned ? 1 : 0, teamId, b.requiresAck ? 1 : 0, ctx.user.id, Date.now(), days ? Date.now() + days * 86400e3 : null);
    const audience = teamId ? [teamId] : q.all('SELECT id FROM teams').map(t => t.id);
    for (const a of q.all(`SELECT id FROM users WHERE role = 'agent' AND status = 'active' AND team_id IN (${inList(audience)})`, ...audience))
      notify(a.id, `New announcement: ${String(b.title).slice(0, 80)}`, '#/home');
    audit(ctx.user.id, 'announcement_published', res.lastInsertRowid);
    return { ok: true, id: Number(res.lastInsertRowid) };
  });

  /* ----- agent accounts (managers create agents in their own teams) ----- */
  r.post('/api/team/agents', STAFF, ctx => {
    const b = ctx.body, teamId = int(b.teamId, 'Team');
    if (!managedTeamIds(ctx.user).includes(teamId)) fail(404, 'Team not found.');
    const res = q.run(`INSERT INTO users(role, username, name, email, employee_id, mobile, team_id, status, created_at) VALUES ('agent', ?, ?, ?, ?, ?, ?, 'invited', ?)`,
      vUsername(b.username), str(b.name, 'Name', { max: 100 }), vEmail(b.email), str(b.employeeId, 'Employee ID', { max: 40, optional: true }), str(b.mobile, 'Mobile', { max: 30, optional: true }), teamId, Date.now());
    const link = issueLink(Number(res.lastInsertRowid), 'invite');
    audit(ctx.user.id, 'agent_created', res.lastInsertRowid);
    return { ok: true, id: Number(res.lastInsertRowid), link: link.url, expiresAt: link.expiresAt, emailed: false };
  });
  r.post('/api/team/agents/:id/link', STAFF, ctx => {
    const a = managedAgent(ctx.user, ctx.params.id);
    if (a.status === 'deactivated') fail(409, 'Reactivate the account first.');
    const kind = a.status === 'invited' ? 'invite' : 'reset';
    const link = issueLink(a.id, kind);
    audit(ctx.user.id, kind === 'invite' ? 'invite_resent' : 'reset_link_issued', a.id);
    return { ok: true, kind, link: link.url, expiresAt: link.expiresAt, emailed: false };
  });
  r.post('/api/team/agents/:id/status', STAFF, ctx => {
    const a = managedAgent(ctx.user, ctx.params.id);
    const active = !!ctx.body.active;
    if (active && a.status !== 'deactivated') fail(409, 'This account is not deactivated.');
    const status = active ? (a.password_hash ? 'active' : 'invited') : 'deactivated';
    q.run('UPDATE users SET status = ? WHERE id = ?', status, a.id);
    if (!active) { q.run('DELETE FROM sessions WHERE user_id = ?', a.id); q.run("UPDATE location_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'", a.id); }
    audit(ctx.user.id, active ? 'account_reactivated' : 'account_deactivated', a.id);
    return { ok: true, status };
  });
  r.delete('/api/team/agents/:id/passkeys', STAFF, ctx => {
    const a = managedAgent(ctx.user, ctx.params.id);
    const n = q.run('DELETE FROM webauthn_credentials WHERE user_id = ?', a.id).changes;
    audit(ctx.user.id, 'passkeys_removed_by_staff', a.id, { count: n });
    notify(a.id, 'Your passkeys were removed by your manager. Sign in with your password and add a new one.');
    return { ok: true, removed: n };
  });
}
