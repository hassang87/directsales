// Creates fictional demo data. Only runs in demo mode on an empty database.
import { q, tx } from '../src/db/index.js';
import { hashPassword } from '../src/lib/security.js';
import { bhDate, addDays, bhToUtc } from '../src/lib/time.js';

export function seedDemo() {
  const now = Date.now();
  const pw = { admin: hashPassword('Demo-Admin-2026!'), manager: hashPassword('Demo-Manager-2026!'), agent: hashPassword('Demo-Agent-2026!') };
  tx(() => {
    const team = name => Number(q.run('INSERT INTO teams(name, created_at) VALUES (?, ?)', name, now).lastInsertRowid);
    const north = team('Team North'), south = team('Team South');
    const user = (role, username, name, teamId, status = 'active', extra = {}) => Number(q.run(
      `INSERT INTO users(role, username, name, email, employee_id, mobile, team_id, status, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      role, username, name, `${username}@example.invalid`, extra.emp || null, extra.mobile || null, teamId, status, status === 'active' ? pw[role] : null, now).lastInsertRowid);

    const admin = user('admin', 'demo.admin', 'Demo Administrator', null);
    const m1 = user('manager', 'demo.manager', 'Khalid Al-Mansoori', null);
    const m2 = user('manager', 'demo.manager2', 'Reem Al-Sayed', null);
    q.run('INSERT INTO manager_teams VALUES (?, ?)', m1, north);
    q.run('INSERT INTO manager_teams VALUES (?, ?)', m2, south);
    for (const p of ['medical_documents', 'location_history']) q.run('INSERT INTO permissions VALUES (?, ?)', admin, p);

    const agents = {
      noor: user('agent', 'agent.noor', 'Noor Hasan', north, 'active', { emp: 'DS-1042', mobile: '+973 3000 0001' }),
      faisal: user('agent', 'agent.faisal', 'Faisal Ahmed', north, 'active', { emp: 'DS-1043', mobile: '+973 3000 0002' }),
      mariam: user('agent', 'agent.mariam', 'Mariam Saleh', north, 'active', { emp: 'DS-1044', mobile: '+973 3000 0003' }),
      yusuf: user('agent', 'agent.yusuf', 'Yusuf Ali', south, 'active', { emp: 'DS-2001', mobile: '+973 3000 0004' }),
      sara: user('agent', 'agent.sara', 'Sara Mohammed', south, 'active', { emp: 'DS-2002', mobile: '+973 3000 0005' }),
      hamad: user('agent', 'agent.hamad', 'Hamad Khalil', north, 'invited', { emp: 'DS-1045' })
    };

    const wl = (teamId, name, lat, lng) => Number(q.run('INSERT INTO work_locations(team_id, name, lat, lng) VALUES (?, ?, ?, ?)', teamId, name, lat, lng).lastInsertRowid);
    const seef = wl(north, 'Seef Mall Kiosk', 26.2335, 50.5390);
    const jan = wl(north, 'Residential campaign · Janabiyah', 26.2030, 50.4930);
    const adliya = wl(south, 'Street campaign · Adliya', 26.2140, 50.5900);
    const isa = wl(south, 'Isa Town market stand', 26.1720, 50.5480);

    for (const [name, medical, doc] of [['Annual', 0, 0], ['Sick', 1, 1], ['Emergency', 0, 0]])
      q.run('INSERT OR IGNORE INTO leave_types(name, medical, requires_document) VALUES (?, ?, ?)', name, medical, doc);

    // Two published weeks. Friday off for everyone.
    const today = bhDate();
    const plan = { [agents.noor]: seef, [agents.faisal]: seef, [agents.mariam]: jan, [agents.yusuf]: adliya, [agents.sara]: isa, [agents.hamad]: seef };
    for (let i = -3; i < 14; i++) {
      const d = addDays(today, i), dow = new Date(d + 'T00:00:00Z').getUTCDay();
      for (const [uid, loc] of Object.entries(plan)) {
        const off = dow === 5 || (Number(uid) === agents.sara && dow === 4);
        q.run(`INSERT INTO shifts(user_id, date, kind, start_time, end_time, work_location_id, published, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          uid, d, off ? 'off' : 'shift', off ? null : '16:00', off ? null : '00:00', off ? null : loc, m1, now);
      }
    }

    // Two synthetic on-duty sessions so the map and punch list have something to show.
    const synth = (uid, minsAgo, lat, lng, acc) => {
      const t = now - minsAgo * 60e3;
      q.run(`INSERT INTO attendance(user_id, kind, punch_in_at, in_lat, in_lng, in_acc, synthetic, created_at) VALUES (?, 'standard', ?, ?, ?, ?, 1, ?)`, uid, t, lat, lng, acc, t);
      q.run(`INSERT INTO locations(user_id, lat, lng, acc, source, at) VALUES (?, ?, ?, ?, 'punch_in', ?)`, uid, lat, lng, acc, t);
    };
    synth(agents.faisal, 50, 26.2318, 50.5415, 9);
    synth(agents.yusuf, 95, 26.2128, 50.5915, 22);

    q.run(`INSERT INTO leave_requests(user_id, type_id, start_date, end_date, portion, comment, created_at) VALUES (?, 1, ?, ?, 'full', ?, ?)`, agents.mariam, addDays(today, 18), addDays(today, 19), 'Family event', now - 3600e3);
    q.run(`INSERT INTO leave_requests(user_id, type_id, start_date, end_date, portion, status, decided_by, decided_at, created_at) VALUES (?, 1, ?, ?, 'full', 'approved', ?, ?, ?)`, agents.noor, addDays(today, 14), addDays(today, 14), m1, now - 86400e3, now - 2 * 86400e3);

    q.run(`INSERT INTO announcements(title, body, priority, pinned, team_id, requires_ack, created_by, created_at) VALUES (?, ?, 'high', 1, ?, 1, ?, ?)`,
      'New campaign: Janabiyah residential', 'From Saturday, two agents from Team North cover the Janabiyah residential campaign. Check your schedule for your assignment.', north, m1, now - 7200e3);
    q.run(`INSERT INTO announcements(title, body, priority, pinned, team_id, requires_ack, created_by, created_at) VALUES (?, ?, 'normal', 0, NULL, 0, ?, ?)`,
      'Updated price sheet', 'The updated price sheet is with your team leader. Ask them for a copy before your shift.', admin, now - 86400e3);
  });
}
