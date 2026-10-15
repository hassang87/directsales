import { q } from '../db/index.js';
import { fail } from './http.js';

/** Team ids a staff member may see. Admins see every team; agents see none. */
export function managedTeamIds(user) {
  if (user.role === 'admin') return q.all('SELECT id FROM teams').map(r => r.id);
  if (user.role === 'manager') return q.all('SELECT team_id FROM manager_teams WHERE user_id = ?', user.id).map(r => r.team_id);
  return [];
}
export const isStaff = user => user.role === 'manager' || user.role === 'admin';

/** Loads an agent the staff member is allowed to manage, or 404s (so other teams' people stay invisible). */
export function managedAgent(user, agentId) {
  const a = q.get("SELECT * FROM users WHERE id = ? AND role = 'agent'", Number(agentId));
  if (!a || !managedTeamIds(user).includes(a.team_id)) fail(404, 'Not found.');
  return a;
}
export function canManage(user, agentId) {
  try { managedAgent(user, agentId); return true; } catch { return false; }
}
export function hasPerm(user, perm) {
  return !!q.get('SELECT 1 FROM permissions WHERE user_id = ? AND perm = ?', user.id, perm);
}
/** SQL fragment + params restricting a users table alias to managed teams. */
export function teamScope(user, alias = 'u') {
  const ids = managedTeamIds(user);
  if (!ids.length) return { sql: '0', params: [] };
  return { sql: `${alias}.team_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}
export const publicUser = u => u && ({ id: u.id, role: u.role, username: u.username, name: u.name, email: u.email, employeeId: u.employee_id, mobile: u.mobile, teamId: u.team_id, status: u.status });
