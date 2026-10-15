import { api, h, clear, icon, pill, empty, spinner, note, field, errorBox, dtm, openSheet, closeSheet, confirmSheet, toast, copy, S } from './core.js';

const refresh = () => window.dispatchEvent(new CustomEvent('rerender'));
const PERM_LABELS = { medical_documents: 'Open medical documents', location_history: 'See location history' };

export async function admin(view, sub) {
  const tab = sub || 'staff';
  view.append(h('h2', { text: 'Administration' }), h('div', { class: 'chips' },
    [['staff', 'Managers & admins'], ['teams', 'Teams'], ['leave', 'Leave types'], ['settings', 'Settings'], ['audit', 'Audit log'], ['access', 'Access log']]
      .map(([k, l]) => h('a', { class: `chip ${tab === k ? 'on' : ''}`, href: k === 'staff' ? '#/admin' : `#/admin/${k}`, text: l, style: 'text-decoration:none' }))));
  const fn = { staff, teams, leave: leaveTypes, settings, audit, access }[tab] || staff;
  await fn(view);
}

async function staff(view) {
  view.append(h('button', { class: 'btn primary', style: 'margin-bottom:14px', on: { click: addStaff } }, icon('plus'), 'Add manager or admin'), spinner());
  const [rows, teamsList] = await Promise.all([api('/api/admin/staff'), api('/api/admin/teams')]);
  view.lastChild.remove();
  view.append(h('div', { class: 'list' }, rows.map(u => h('button', { class: 'card item', on: { click: () => staffSheet(u, teamsList) } },
    h('div', { class: 'avatar sm staff', text: u.name.split(' ').map(w => w[0]).slice(0, 2).join('') }),
    h('div', { class: 'main' }, h('div', { class: 't', text: `${u.name} · ${u.role}` }),
      h('div', { class: 's', text: [u.username, u.role === 'manager' ? (u.teams.map(t => teamsList.find(x => x.id === t)?.name).filter(Boolean).join(', ') || 'no teams') : 'all teams',
        u.totp ? 'two-step on' : 'two-step not set', u.passkeys ? `${u.passkeys} passkey${u.passkeys > 1 ? 's' : ''}` : null, ...u.perms.map(p => PERM_LABELS[p].toLowerCase())].filter(Boolean).join(' · ') })),
    u.status === 'active' ? pill('Active', 'green') : u.status === 'invited' ? pill('Invited', 'blue') : pill('Deactivated', 'red')))));
}
function linkView(s, title, r) {
  s.render([h('h1', { text: title }), h('p', { class: 'lead', text: `Send this single-use link privately. It expires ${dtm(r.expiresAt)}.` }), h('div', { class: 'linkbox', style: 'margin-top:14px', text: r.link }),
    note('Email delivery is not set up yet, so the link is shown here instead.', 'alert', 'warn')],
    [h('button', { class: 'btn primary', text: 'Copy link', on: { click: () => copy(r.link) } }), h('button', { class: 'btn ghost', text: 'Done', on: { click: () => { closeSheet(); refresh(); } } })]);
}
async function addStaff() {
  const s = openSheet('Add manager or admin');
  const teamsList = await api('/api/admin/teams');
  const name = h('input', { maxlength: 100 }), user = h('input', { maxlength: 40, autocapitalize: 'none' }), email = h('input', { type: 'email' });
  const role = h('select', {}, h('option', { value: 'manager', text: 'Manager' }), h('option', { value: 'admin', text: 'Administrator' }));
  const boxes = teamsList.map(t => ({ t, cb: h('input', { type: 'checkbox' }) }));
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: 'Create and get invitation link', on: { click: async () => {
    clear(err); btn.disabled = true;
    try { const r = await api('/api/admin/staff', { method: 'POST', body: { name: name.value, username: user.value, email: email.value, role: role.value, teamIds: boxes.filter(b => b.cb.checked).map(b => b.t.id) } }); linkView(s, 'Account created', r); }
    catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Full name', name), field('Username', user), field('Email', email), field('Role', role),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Teams this manager can see' }), boxes.map(b => h('label', { class: 'check' }, b.cb, b.t.name))),
    note('Sensitive permissions (medical documents, location history) are granted separately after the account exists.'), err], [btn]);
}
function staffSheet(u, teamsList) {
  const s = openSheet(u.name);
  const tb = teamsList.map(t => ({ t, cb: h('input', { type: 'checkbox', checked: u.teams.includes(t.id) }) }));
  const pb = Object.keys(PERM_LABELS).map(p => ({ p, cb: h('input', { type: 'checkbox', checked: u.perms.includes(p) }) }));
  const err = h('div');
  const save = h('button', { class: 'btn primary', text: 'Save changes', on: { click: async () => {
    clear(err); save.disabled = true;
    try { await api(`/api/admin/staff/${u.id}`, { method: 'PUT', body: { teamIds: tb.filter(b => b.cb.checked).map(b => b.t.id), perms: pb.filter(b => b.cb.checked).map(b => b.p) } }); closeSheet(); toast('Saved'); refresh(); }
    catch (x) { err.append(errorBox(x)); save.disabled = false; }
  } } });
  s.render([
    h('p', { class: 'lead', text: `${u.username} · ${u.role} · ${u.status}` }),
    u.role === 'manager' ? h('div', { class: 'field', style: 'margin-top:14px' }, h('span', { class: 'lbl', text: 'Teams' }), tb.map(b => h('label', { class: 'check' }, b.cb, b.t.name))) : note('Administrators see every team.', 'users'),
    h('div', { class: 'field' }, h('span', { class: 'lbl', text: 'Sensitive permissions' }), pb.map(b => h('label', { class: 'check' }, b.cb, PERM_LABELS[b.p]))),
    note('Grant medical documents only to the people your organisation has decided should see them, and record that decision.', 'lock'), err
  ], [save,
    u.status !== 'deactivated' ? h('button', { class: 'btn ghost', text: u.status === 'invited' ? 'Resend invitation link' : 'Create password reset link', on: { click: async () => { try { const r = await api(`/api/admin/users/${u.id}/link`, { method: 'POST', body: {} }); linkView(s, 'New link', r); } catch (x) { toast(x.message); } } } }) : null,
    h('button', { class: 'btn ghost', text: 'Reset two-step sign-in and passkeys', on: { click: () => confirmSheet('Reset two-step sign-in?', `${u.name} is signed out, their passkeys are removed, and they set up two-step sign-in again next time.`, 'Reset', async () => { await api(`/api/admin/users/${u.id}/reset-mfa`, { method: 'POST', body: {} }); toast('Reset done'); refresh(); }) } }),
    u.id !== S.user.id ? h('button', { class: 'btn link', text: u.status === 'deactivated' ? 'Reactivate account' : 'Deactivate account', on: { click: () => confirmSheet(u.status === 'deactivated' ? 'Reactivate account?' : 'Deactivate account?', u.status === 'deactivated' ? `${u.name} can sign in again.` : `${u.name} is signed out everywhere immediately.`, 'Confirm', async () => { await api(`/api/admin/staff/${u.id}`, { method: 'PUT', body: { active: u.status === 'deactivated' } }); refresh(); }) } }) : null]);
}

async function teams(view) {
  view.append(spinner());
  const rows = await api('/api/admin/teams');
  view.lastChild.remove();
  const name = h('input', { maxlength: 60, placeholder: 'e.g. Team East' });
  const err = h('div');
  view.append(h('div', { class: 'list' }, rows.map(t => h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('users')), h('div', { class: 'main' }, h('div', { class: 't', text: t.name }), h('div', { class: 's', text: `${t.agents} agent${t.agents === 1 ? '' : 's'}` }))))),
    h('h3', { text: 'Add a team' }), h('div', { class: 'card' }, field('Team name', name), err, h('button', { class: 'btn dark', text: 'Add team', on: { click: async () => {
      clear(err);
      try { await api('/api/admin/teams', { method: 'POST', body: { name: name.value } }); toast('Team added'); const t = await api('/api/team/teams'); S.teams = t; refresh(); }
      catch (x) { err.append(errorBox(x)); }
    } } })));
}

async function leaveTypes(view) {
  view.append(spinner());
  const rows = await api('/api/admin/leave-types');
  view.lastChild.remove();
  const toggle = (t, key, label) => {
    const cb = h('input', { type: 'checkbox', checked: !!t[key], on: { change: async () => { try { await api(`/api/admin/leave-types/${t.id}`, { method: 'PUT', body: { [key]: cb.checked } }); toast('Saved'); } catch (x) { toast(x.message); cb.checked = !cb.checked; } } } });
    return h('label', { class: 'check', style: 'margin:0' }, cb, label);
  };
  view.append(h('div', { class: 'list' }, rows.map(t => h('div', { class: 'card' }, h('b', { text: t.name }),
    h('div', { class: 'row wrap', style: 'margin-top:10px;gap:16px' }, toggle(t, 'active', 'Available'), toggle(t, 'medical', 'Medical'), toggle(t, 'requiresDocument', 'Document required'))))),
    note('Leave balances and entitlements are not set by the portal. Your HR policy decides them.', 'doc'));
  const name = h('input', { maxlength: 60 }), med = h('input', { type: 'checkbox' }), doc = h('input', { type: 'checkbox' }); const err = h('div');
  view.append(h('h3', { text: 'Add a leave type' }), h('div', { class: 'card' }, field('Name', name), h('label', { class: 'check' }, med, 'Medical (documents need the medical permission)'), h('label', { class: 'check' }, doc, 'Document required'), err,
    h('button', { class: 'btn dark', text: 'Add leave type', on: { click: async () => { clear(err); try { await api('/api/admin/leave-types', { method: 'POST', body: { name: name.value, medical: med.checked, requiresDocument: doc.checked } }); refresh(); } catch (x) { err.append(errorBox(x)); } } } })));
}

async function settings(view) {
  view.append(spinner());
  const st = await api('/api/admin/settings');
  view.lastChild.remove();
  const inputs = {};
  const yes = (k, label, help) => { inputs[k] = h('input', { type: 'checkbox', checked: st[k] === '1' }); return h('div', { class: 'field' }, h('label', { class: 'check', style: 'margin:0' }, inputs[k], label), help ? h('span', { class: 'help', text: help }) : null); };
  const num = (k, label, help) => { inputs[k] = h('input', { inputmode: 'numeric', value: st[k] ?? '' }); return field(label, inputs[k], help); };
  const err = h('div');
  view.append(h('div', { class: 'card' },
    h('h3', { style: 'margin-top:0', text: 'Sign-in' }),
    yes('staff_mfa_required', 'Managers and admins need two-step sign-in'),
    yes('passkeys_enabled', 'Allow passkeys'),
    yes('passkey_satisfies_mfa', 'A passkey counts as two-step sign-in', 'A passkey with Face ID, fingerprint or screen lock already proves two factors.'),
    num('invite_hours', 'Invitation links valid for (hours)'), num('reset_hours', 'Reset links valid for (hours)'),
    h('h3', { text: 'Attendance and location' }),
    num('photo_max_age_seconds', 'Selfie must be uploaded within (seconds)'),
    num('location_max_accuracy_m', 'Flag punch-ins less accurate than (metres)'),
    num('stale_minutes', 'Call a location stale after (minutes)'),
    num('location_request_minutes', 'Location requests expire after (minutes)'),
    h('h3', { text: 'Retention' }),
    num('photo_retention_days', 'Delete punch-in photos after (days)', 'Leave empty until your organisation decides. Nothing is deleted while it is empty.'),
    err,
    h('button', { class: 'btn primary', text: 'Save settings', on: { click: async () => {
      clear(err);
      const body = {};
      for (const [k, el] of Object.entries(inputs)) body[k] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value.trim();
      try { await api('/api/admin/settings', { method: 'PUT', body }); toast('Settings saved'); } catch (x) { err.append(errorBox(x)); }
    } } })));
}

async function audit(view) {
  view.append(spinner());
  const rows = await api('/api/admin/audit');
  view.lastChild.remove();
  view.append(rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Target', 'Detail'].map(t => h('th', { text: t })))),
    h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'num', text: dtm(r.at) }), h('td', { text: r.actor || 'System' }), h('td', { text: r.action.replace(/_/g, ' ') }), h('td', { text: r.target || '' }), h('td', { text: r.detail || '' })))))) : empty('Nothing logged yet.'));
}
async function access(view) {
  view.append(note('Every view of a punch-in photo, medical document or location history is recorded here, including refused attempts.', 'eye'), spinner());
  const rows = await api('/api/admin/access');
  view.lastChild.remove();
  view.append(h('div', { style: 'margin-top:12px' }, rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Who', 'Looked at', 'Whose', 'Result'].map(t => h('th', { text: t })))),
    h('tbody', {}, rows.map(r => h('tr', {}, h('td', { class: 'num', text: dtm(r.at) }), h('td', { text: r.actor }), h('td', { text: r.kind.replace(/_/g, ' ') }), h('td', { text: r.subject || '' }), h('td', {}, r.allowed ? pill('Allowed', 'green') : pill('Refused', 'red'))))))) : empty('No sensitive data has been opened yet.')));
}
