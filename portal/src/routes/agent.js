import fs from 'node:fs';
import { q, tx, settingNum } from '../db/index.js';
import { fail } from '../lib/http.js';
import { randomToken, sha256 } from '../lib/security.js';
import { audit, access, notify, rateLimit } from '../lib/services.js';
import { decodeDataUrl, isCompleteJpeg, saveFile, deleteFile, filePath, sniff, pdfIsSafe, MIME } from '../lib/storage.js';
import { bhDate, addDays, isDate } from '../lib/time.js';
import { str, int, oneOf, reading } from '../lib/validate.js';
import { canManage, hasPerm, isStaff } from '../lib/access.js';

const AGENT = { roles: ['agent'] };
const EXC_REASONS = ['Camera not working', 'Location unavailable', 'Permission denied on my phone', 'No mobile data', 'Other'];

export function notifyManagers(teamId, text, link) {
  for (const m of q.all("SELECT u.id FROM manager_teams mt JOIN users u ON u.id = mt.user_id WHERE mt.team_id = ? AND u.status = 'active'", teamId)) notify(m.id, text, link);
}
export function expireLocationRequests() {
  q.run("UPDATE location_requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?", Date.now() - settingNum('location_request_minutes') * 60e3);
}
const openSession = userId => q.get('SELECT * FROM attendance WHERE user_id = ? AND punch_out_at IS NULL', userId);
const shiftRow = s => s && ({ date: s.date, kind: s.kind, start: s.start_time, end: s.end_time, location: s.wl_id ? { id: s.wl_id, name: s.wl_name, lat: s.wl_lat, lng: s.wl_lng } : null });
const SHIFT_SQL = `SELECT s.*, w.id wl_id, w.name wl_name, w.lat wl_lat, w.lng wl_lng FROM shifts s LEFT JOIN work_locations w ON w.id = s.work_location_id`;
export const attendanceRow = a => a && ({
  id: a.id, kind: a.kind, punchInAt: a.punch_in_at, punchOutAt: a.punch_out_at,
  in: a.in_lat != null ? { lat: a.in_lat, lng: a.in_lng, acc: a.in_acc } : null,
  out: a.out_lat != null ? { lat: a.out_lat, lng: a.out_lng, acc: a.out_acc } : null,
  hasPhoto: !!a.photo_file, excReason: a.exc_reason, excNote: a.exc_note, excStatus: a.exc_status, excComment: a.exc_comment, synthetic: !!a.synthetic
});
function visibleAnnouncements(user) {
  const now = Date.now();
  return q.all(`SELECT a.*, u.name author, (SELECT 1 FROM announcement_acks k WHERE k.announcement_id = a.id AND k.user_id = ?) acked
                FROM announcements a JOIN users u ON u.id = a.created_by
                WHERE (a.team_id IS NULL OR a.team_id = ?) AND (a.expires_at IS NULL OR a.expires_at > ?)
                ORDER BY a.pinned DESC, a.created_at DESC LIMIT 50`, user.id, user.team_id, now)
    .map(a => ({ id: a.id, title: a.title, body: a.body, priority: a.priority, pinned: !!a.pinned, requiresAck: !!a.requires_ack, acked: !!a.acked, author: a.author, createdAt: a.created_at }));
}

export default function (r) {
  r.get('/api/me/home', AGENT, ctx => {
    const u = ctx.user, today = bhDate();
    expireLocationRequests();
    const shift = q.get(`${SHIFT_SQL} WHERE s.user_id = ? AND s.date = ? AND s.published = 1`, u.id, today);
    const nextOff = q.get("SELECT date FROM shifts WHERE user_id = ? AND date > ? AND kind = 'off' AND published = 1 ORDER BY date LIMIT 1", u.id, today);
    const req = q.get(`SELECT r.id, r.reason, r.created_at createdAt, m.name manager FROM location_requests r JOIN users m ON m.id = r.manager_id
                       WHERE r.user_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1`, u.id);
    return {
      today,
      shift: shiftRow(shift),
      nextOff: nextOff?.date || null,
      open: attendanceRow(openSession(u.id)),
      locationRequest: req || null,
      announcements: visibleAnnouncements(u).slice(0, 5),
      unread: q.get('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', u.id).n,
      leave: q.all(`SELECT l.id, t.name type, l.start_date start, l.end_date end, l.status FROM leave_requests l JOIN leave_types t ON t.id = l.type_id
                    WHERE l.user_id = ? AND l.end_date >= ? AND l.status IN ('pending','approved') ORDER BY l.start_date LIMIT 5`, u.id, today)
    };
  });

  r.get('/api/me/schedule', AGENT, ctx => {
    const from = isDate(ctx.query.get('from')) ? ctx.query.get('from') : bhDate();
    const to = isDate(ctx.query.get('to')) ? ctx.query.get('to') : addDays(from, 13);
    return {
      from, to,
      shifts: q.all(`${SHIFT_SQL} WHERE s.user_id = ? AND s.date BETWEEN ? AND ? AND s.published = 1 ORDER BY s.date`, ctx.user.id, from, to).map(shiftRow),
      leave: q.all(`SELECT l.id, t.name type, l.start_date start, l.end_date end, l.portion, l.status FROM leave_requests l JOIN leave_types t ON t.id = l.type_id
                    WHERE l.user_id = ? AND l.status IN ('pending','approved') AND l.end_date >= ? AND l.start_date <= ? ORDER BY l.start_date`, ctx.user.id, from, to)
    };
  });

  /* ----- punch in / out ----- */
  r.post('/api/punch/start', AGENT, ctx => {
    if (!rateLimit('punch-start:' + ctx.user.id, 20, 10 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    if (openSession(ctx.user.id)) fail(409, 'You are already punched in.', 'already_on_duty');
    const id = randomToken(16);
    q.run('INSERT INTO punch_submissions(id, user_id, session_id, created_at) VALUES (?, ?, ?, ?)', id, ctx.user.id, ctx.session.id, Date.now());
    return { submissionId: id, maxPhotoAgeSeconds: settingNum('photo_max_age_seconds'), maxAccuracy: settingNum('location_max_accuracy_m') };
  });

  function takeSubmission(ctx) {
    const s = q.get('SELECT * FROM punch_submissions WHERE id = ? AND user_id = ?', String(ctx.body.submissionId || ''), ctx.user.id);
    if (!s || s.session_id !== ctx.session.id) fail(400, 'This punch could not be matched to your sign-in. Start again.', 'bad_submission');
    if (s.used_at) {
      const a = q.get('SELECT * FROM attendance WHERE id = ?', s.attendance_id);
      const e = new Error('dup'); e.dup = attendanceRow(a); throw e;
    }
    if (Date.now() - s.created_at > 10 * 60e3) fail(410, 'This punch took too long. Start again.', 'submission_expired');
    return s;
  }
  const replayGuard = fn => ctx => {
    try { return fn(ctx); }
    catch (e) { if (e.dup) { ctx.status = 200; return { ok: true, alreadySaved: true, attendance: e.dup }; } throw e; }
  };

  r.post('/api/punch/in', { ...AGENT, bodyLimit: 6 * 1024 * 1024 }, replayGuard(ctx => {
    const u = ctx.user;
    if (!rateLimit('punch:' + u.id, 20, 10 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const sub = takeSubmission(ctx);
    const loc = reading(ctx.body);
    const capturedAt = Number(ctx.body.capturedAt);
    const maxAge = settingNum('photo_max_age_seconds') * 1000;
    if (!Number.isFinite(capturedAt) || Date.now() - capturedAt > maxAge || capturedAt - Date.now() > 30e3) fail(400, 'The selfie is too old. Take a new one.', 'photo_stale');
    const photo = decodeDataUrl(ctx.body.photo, settingNum('photo_max_bytes'));
    if (!isCompleteJpeg(photo)) fail(400, 'The selfie didn’t upload completely. Try again.', 'photo_incomplete');
    const hash = sha256(photo);
    if (q.get('SELECT 1 FROM attendance WHERE photo_sha256 = ?', hash)) fail(409, 'This photo was already used. Take a new selfie.', 'photo_reused');
    if (openSession(u.id)) fail(409, 'You are already punched in.', 'already_on_duty');

    const lowAcc = loc.acc > settingNum('location_max_accuracy_m');
    const file = saveFile(photo, 'jpg');
    try {
      const a = tx(() => {
        const now = Date.now();
        const res = q.run(`INSERT INTO attendance(user_id, kind, punch_in_at, in_lat, in_lng, in_acc, photo_file, photo_sha256, exc_reason, exc_status, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          u.id, lowAcc ? 'exception' : 'standard', now, loc.lat, loc.lng, loc.acc, file, hash,
          lowAcc ? `Low location accuracy (±${loc.acc} m)` : null, lowAcc ? 'pending' : null, now);
        q.run("INSERT INTO locations(user_id, lat, lng, acc, source, at) VALUES (?, ?, ?, ?, 'punch_in', ?)", u.id, loc.lat, loc.lng, loc.acc, now);
        q.run('UPDATE punch_submissions SET used_at = ?, attendance_id = ? WHERE id = ?', now, res.lastInsertRowid, sub.id);
        return q.get('SELECT * FROM attendance WHERE id = ?', res.lastInsertRowid);
      });
      if (lowAcc) notifyManagers(u.team_id, `${u.name} punched in with a low-accuracy location. Review it in Punches.`, '#/punches');
      audit(u.id, 'punch_in', a.id, a.kind);
      return { ok: true, attendance: attendanceRow(a) };
    } catch (e) {
      deleteFile(file); // a failed save leaves no file behind
      if (/one_open_session|attendance\.user_id/.test(e.message)) fail(409, 'You are already punched in.', 'already_on_duty');
      if (/photo_sha256/.test(e.message)) fail(409, 'This photo was already used. Take a new selfie.', 'photo_reused');
      throw e;
    }
  }));

  r.post('/api/punch/exception', AGENT, replayGuard(ctx => {
    const u = ctx.user;
    if (!rateLimit('punch:' + u.id, 20, 10 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const sub = takeSubmission(ctx);
    const reason = oneOf(ctx.body.reason, 'Reason', EXC_REASONS);
    const note = str(ctx.body.note, 'Details', { max: 500, optional: true });
    let loc = null;
    if (ctx.body.lat != null) loc = reading(ctx.body);
    if (openSession(u.id)) fail(409, 'You are already punched in.', 'already_on_duty');
    try {
      const a = tx(() => {
        const now = Date.now();
        const res = q.run(`INSERT INTO attendance(user_id, kind, punch_in_at, in_lat, in_lng, in_acc, exc_reason, exc_note, exc_status, created_at)
                           VALUES (?, 'exception', ?, ?, ?, ?, ?, ?, 'pending', ?)`, u.id, now, loc?.lat ?? null, loc?.lng ?? null, loc?.acc ?? null, reason, note, now);
        if (loc) q.run("INSERT INTO locations(user_id, lat, lng, acc, source, at) VALUES (?, ?, ?, ?, 'punch_in', ?)", u.id, loc.lat, loc.lng, loc.acc, now);
        q.run('UPDATE punch_submissions SET used_at = ?, attendance_id = ? WHERE id = ?', now, res.lastInsertRowid, sub.id);
        return q.get('SELECT * FROM attendance WHERE id = ?', res.lastInsertRowid);
      });
      notifyManagers(u.team_id, `${u.name} submitted an attendance exception for review.`, '#/punches');
      audit(u.id, 'punch_exception', a.id, reason);
      return { ok: true, attendance: attendanceRow(a) };
    } catch (e) {
      if (/one_open_session|attendance\.user_id/.test(e.message)) fail(409, 'You are already punched in.', 'already_on_duty');
      throw e;
    }
  }));

  r.post('/api/punch/out', AGENT, ctx => {
    const u = ctx.user;
    if (!rateLimit('punch:' + u.id, 20, 10 * 60e3)) fail(429, 'Too many attempts. Wait a few minutes.', 'rate_limited');
    const loc = reading(ctx.body);
    const a = tx(() => {
      const open = openSession(u.id);
      if (!open) fail(409, 'You are not punched in.', 'not_on_duty');
      const now = Date.now();
      q.run('UPDATE attendance SET punch_out_at = ?, out_lat = ?, out_lng = ?, out_acc = ? WHERE id = ? AND punch_out_at IS NULL', now, loc.lat, loc.lng, loc.acc, open.id);
      q.run("INSERT INTO locations(user_id, lat, lng, acc, source, at) VALUES (?, ?, ?, ?, 'punch_out', ?)", u.id, loc.lat, loc.lng, loc.acc, now);
      q.run("UPDATE location_requests SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'", u.id);
      return q.get('SELECT * FROM attendance WHERE id = ?', open.id);
    });
    audit(u.id, 'punch_out', a.id);
    return { ok: true, attendance: attendanceRow(a) };
  });

  r.get('/api/me/attendance', AGENT, ctx =>
    q.all('SELECT * FROM attendance WHERE user_id = ? ORDER BY punch_in_at DESC LIMIT 60', ctx.user.id).map(attendanceRow));

  /* Punch-in photo: the agent, or staff who manage the agent's team. Every view is logged. */
  r.get('/api/attendance/:id/photo', ctx => {
    const a = q.get('SELECT * FROM attendance WHERE id = ?', Number(ctx.params.id));
    if (!a || !a.photo_file) fail(404, 'Photo not found.');
    const allowed = a.user_id === ctx.user.id || (isStaff(ctx.user) && canManage(ctx.user, a.user_id));
    access(ctx.user.id, 'punch_photo', a.user_id, a.id, allowed);
    if (!allowed) fail(404, 'Photo not found.');
    let data; try { data = fs.readFileSync(filePath(a.photo_file)); } catch { fail(404, 'Photo not found.'); }
    ctx.res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' });
    ctx.res.end(data); ctx.streamed = true;
  });

  /* ----- location sharing (on duty only) ----- */
  r.post('/api/location/share', AGENT, ctx => {
    const u = ctx.user;
    if (!rateLimit('share:' + u.id, 30, 10 * 60e3)) fail(429, 'Too many shares. Wait a few minutes.', 'rate_limited');
    if (!openSession(u.id)) fail(409, 'Punch in first. Sharing is only for on-duty time.', 'off_duty');
    const loc = reading(ctx.body);
    expireLocationRequests();
    const now = Date.now();
    const pending = q.all("SELECT id FROM location_requests WHERE user_id = ? AND status = 'pending'", u.id);
    tx(() => {
      q.run('INSERT INTO locations(user_id, lat, lng, acc, source, request_id, at) VALUES (?, ?, ?, ?, ?, ?, ?)', u.id, loc.lat, loc.lng, loc.acc, pending.length ? 'request' : 'share', pending[0]?.id ?? null, now);
      q.run("UPDATE location_requests SET status = 'answered', answered_at = ? WHERE user_id = ? AND status = 'pending'", now, u.id);
    });
    return { ok: true, answeredRequests: pending.length };
  });
  r.get('/api/me/locations', AGENT, ctx => q.all('SELECT lat, lng, acc, source, at FROM locations WHERE user_id = ? ORDER BY at DESC LIMIT 50', ctx.user.id));

  /* ----- leave ----- */
  r.get('/api/leave/types', ctx => q.all('SELECT id, name, medical, requires_document requiresDocument FROM leave_types WHERE active = 1 ORDER BY id'));
  r.get('/api/me/leave', AGENT, ctx => q.all(`SELECT l.id, t.name type, l.start_date start, l.end_date end, l.portion, l.comment, l.status, l.decision_comment decisionComment,
       l.created_at createdAt, l.decided_at decidedAt, l.doc_file IS NOT NULL hasDocument FROM leave_requests l JOIN leave_types t ON t.id = l.type_id
       WHERE l.user_id = ? ORDER BY l.created_at DESC LIMIT 100`, ctx.user.id));
  r.post('/api/leave', { ...AGENT, bodyLimit: 8 * 1024 * 1024 }, ctx => {
    const u = ctx.user, b = ctx.body;
    if (!rateLimit('leave:' + u.id, 20, 60 * 60e3)) fail(429, 'Too many requests. Try again later.', 'rate_limited');
    const type = q.get('SELECT * FROM leave_types WHERE id = ? AND active = 1', int(b.typeId, 'Leave type'));
    if (!type) fail(400, 'Choose a leave type.');
    if (!isDate(b.start) || !isDate(b.end)) fail(400, 'Choose valid dates.');
    if (b.end < b.start) fail(400, 'The end date is before the start date.');
    const portion = oneOf(b.portion || 'full', 'Duration', ['full', 'morning', 'afternoon']);
    if (portion !== 'full' && b.start !== b.end) fail(400, 'Half days can only be requested for a single date.');
    const comment = str(b.comment, 'Comment', { max: 500, optional: true });
    let docFile = null, docType = null;
    if (b.document) {
      const buf = decodeDataUrl(b.document, settingNum('doc_max_bytes'));
      docType = sniff(buf);
      if (!docType) fail(400, 'Documents must be a PDF, JPG or PNG.', 'bad_document');
      if (docType === 'pdf' && !pdfIsSafe(buf)) fail(400, 'This PDF contains scripts or embedded files and can’t be accepted.', 'unsafe_pdf');
      docFile = saveFile(buf, docType);
    } else if (type.requires_document) fail(400, `${type.name} leave needs a supporting document.`, 'document_required');
    try {
      const res = q.run(`INSERT INTO leave_requests(user_id, type_id, start_date, end_date, portion, comment, doc_file, doc_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        u.id, type.id, b.start, b.end, portion, comment, docFile, docType, Date.now());
      notifyManagers(u.team_id, `${u.name} sent a leave request for your decision.`, '#/requests');
      audit(u.id, 'leave_requested', res.lastInsertRowid);
      return { ok: true, id: Number(res.lastInsertRowid) };
    } catch (e) { deleteFile(docFile); throw e; }
  });
  r.post('/api/leave/:id/cancel', AGENT, ctx => {
    const l = q.get("SELECT * FROM leave_requests WHERE id = ? AND user_id = ?", Number(ctx.params.id), ctx.user.id);
    if (!l) fail(404, 'Request not found.');
    if (l.status !== 'pending') fail(409, 'Only pending requests can be cancelled here. Ask your manager to cancel an approved one.', 'not_pending');
    q.run("UPDATE leave_requests SET status = 'cancelled' WHERE id = ?", l.id);
    audit(ctx.user.id, 'leave_cancelled', l.id);
    return { ok: true };
  });
  /* Leave documents: the agent, or staff managing the agent. Medical documents also need the explicit medical_documents permission. */
  r.get('/api/leave/:id/document', ctx => {
    const l = q.get('SELECT l.*, t.medical FROM leave_requests l JOIN leave_types t ON t.id = l.type_id WHERE l.id = ?', Number(ctx.params.id));
    if (!l || !l.doc_file) fail(404, 'Document not found.');
    const own = l.user_id === ctx.user.id;
    const allowed = own || (isStaff(ctx.user) && canManage(ctx.user, l.user_id) && (!l.medical || hasPerm(ctx.user, 'medical_documents')));
    access(ctx.user.id, l.medical ? 'medical_document' : 'leave_document', l.user_id, l.id, allowed);
    if (!allowed) fail(403, l.medical ? 'You need the medical documents permission to open this file.' : 'You can’t open this file.', 'forbidden');
    const data = fs.readFileSync(filePath(l.doc_file));
    ctx.res.writeHead(200, { 'Content-Type': MIME[l.doc_type], 'Content-Length': data.length, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox" });
    ctx.res.end(data); ctx.streamed = true;
  });

  /* ----- announcements & notifications ----- */
  r.get('/api/me/announcements', AGENT, ctx => visibleAnnouncements(ctx.user));
  r.post('/api/announcements/:id/ack', AGENT, ctx => {
    const a = visibleAnnouncements(ctx.user).find(x => x.id === Number(ctx.params.id));
    if (!a) fail(404, 'Announcement not found.');
    q.run('INSERT OR IGNORE INTO announcement_acks(announcement_id, user_id, at) VALUES (?, ?, ?)', a.id, ctx.user.id, Date.now());
    return { ok: true };
  });
  r.get('/api/notifications', ctx => q.all('SELECT id, text, link, created_at createdAt, read_at readAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', ctx.user.id));
  r.post('/api/notifications/read', ctx => { q.run('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', Date.now(), ctx.user.id); return { ok: true }; });
}
