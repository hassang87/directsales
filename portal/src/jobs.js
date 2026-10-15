import { q, setting } from './db/index.js';
import { deleteFile, sweepOrphans } from './lib/storage.js';
import { notify, audit } from './lib/services.js';
import { expireLocationRequests } from './routes/agent.js';
import { bhDate, shiftWindow, addDays } from './lib/time.js';

/** Background housekeeping. Runs in the single server process (see README → Scaling). */
export function runJobs() {
  const now = Date.now();
  expireLocationRequests();
  q.run('DELETE FROM webauthn_challenges WHERE expires_at < ?', now - 3600e3);
  q.run('DELETE FROM punch_submissions WHERE created_at < ? AND used_at IS NULL', now - 24 * 3600e3);
  q.run('DELETE FROM tokens WHERE expires_at < ?', now - 30 * 86400e3);

  // Missing punch-out: flag and remind both sides once. Never close a session with an invented time.
  for (const a of q.all(`SELECT a.id, a.user_id, a.punch_in_at, u.name, u.team_id FROM attendance a JOIN users u ON u.id = a.user_id
                         WHERE a.punch_out_at IS NULL AND a.punch_in_at < ?`, now - 4 * 3600e3)) {
    const d = bhDate(a.punch_in_at);
    const s = q.get("SELECT * FROM shifts WHERE user_id = ? AND date IN (?, ?) AND kind = 'shift' AND published = 1 ORDER BY date DESC LIMIT 1", a.user_id, d, addDays(d, -1));
    const end = s ? shiftWindow(s.date, s.start_time, s.end_time)[1] : a.punch_in_at + 12 * 3600e3;
    if (now < end + 2 * 3600e3) continue;
    if (q.get("SELECT 1 FROM audit_log WHERE action = 'missing_punch_out_flagged' AND target = ?", String(a.id))) continue;
    notify(a.user_id, 'You are still punched in from an earlier shift. Punch out, or ask for a correction if you forgot.', '#/attendance');
    for (const m of q.all('SELECT user_id FROM manager_teams WHERE team_id = ?', a.team_id)) notify(m.user_id, `${a.name} has no punch-out recorded for an earlier shift.`, '#/punches');
    audit(null, 'missing_punch_out_flagged', a.id);
  }

  // Photo retention: only when the organisation has configured it.
  const days = Number(setting('photo_retention_days'));
  if (setting('photo_retention_days') !== '' && days > 0) {
    for (const a of q.all('SELECT id, photo_file FROM attendance WHERE photo_file IS NOT NULL AND punch_in_at < ?', now - days * 86400e3)) {
      deleteFile(a.photo_file);
      q.run('UPDATE attendance SET photo_file = NULL WHERE id = ?', a.id);
    }
  }

  const refs = new Set([
    ...q.all('SELECT photo_file f FROM attendance WHERE photo_file IS NOT NULL').map(r => r.f),
    ...q.all('SELECT doc_file f FROM leave_requests WHERE doc_file IS NOT NULL').map(r => r.f)
  ]);
  sweepOrphans(refs);
}

export function startJobs() {
  const tick = () => { try { runJobs(); } catch (e) { console.error('Background job failed:', e); } };
  setTimeout(tick, 5e3).unref();
  setInterval(tick, 15 * 60e3).unref();
}
