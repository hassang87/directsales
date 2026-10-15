import { api, h, clear, icon, $, S, toast, openSheet, closeSheet, dtm, empty, initials, errorBox } from './core.js';
import { renderLogin, renderMfa, renderLink } from './auth.js';
import * as agent from './agent.js';
import * as mgr from './manager.js';
import { admin } from './admin.js';
import { addPasskey, platformAuthenticator, guessDeviceLabel } from './passkey.js';

const view = $('#view'), app = $('#app');

const AGENT_TABS = [['home', 'Home', 'home'], ['schedule', 'Schedule', 'cal'], ['attendance', 'Attendance', 'clock'], ['leave', 'Leave', 'doc'], ['profile', 'Profile', 'user']];
const STAFF_TABS = [['today', 'Today', 'home'], ['map', 'Map', 'map'], ['punches', 'Punches', 'camera'], ['requests', 'Requests', 'list'], ['team', 'Team', 'users']];

async function loadSession() {
  S.session = await api('/api/session');
  S.user = S.session.user; S.csrf = S.session.csrf || null;
  $('#demoBanner').hidden = !S.session.demo;
  if (S.user && S.user.role !== 'agent' && !S.session.mfa) S.teams = await api('/api/team/teams').catch(() => []);
}

function header() {
  const u = S.user, staff = u.role !== 'agent';
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bahrain', hour: 'numeric', hour12: false }).format(Date.now()));
  const bell = h('button', { class: 'iconbtn', 'aria-label': 'Notifications', on: { click: notifications } }, icon('bell'));
  api('/api/notifications').then(n => { if (n.some(x => !x.readAt)) bell.append(h('span', { class: 'dot' })); }).catch(() => {});
  clear($('#top')).append(...[
    h('div', { class: `avatar ${staff ? 'staff' : ''}`, text: initials(u.name) }),
    h('div', { class: 'who' }, h('div', { class: 'hello', text: staff ? `${u.role === 'admin' ? 'Administrator' : 'Manager'}` : (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening') }), h('div', { class: 'name', text: u.name })),
    staff ? h('a', { class: 'iconbtn', href: '#/me', 'aria-label': 'My account' }, icon('user')) : null,
    staff && u.role === 'admin' ? h('a', { class: 'iconbtn', href: '#/admin', 'aria-label': 'Administration' }, icon('gear')) : null,
    bell].filter(Boolean));
}
function tabs(active) {
  const list = S.user.role === 'agent' ? AGENT_TABS : STAFF_TABS;
  clear($('#tabs')).append(...list.map(([k, label, ic]) => h('a', { href: `#/${k}`, class: active === k ? 'active' : '', 'aria-current': active === k ? 'page' : null }, icon(ic, 22), label)));
}
async function notifications() {
  const s = openSheet('Notifications');
  try {
    const n = await api('/api/notifications');
    s.render(n.length ? h('div', { class: 'list' }, n.map(x => h('a', { class: 'card item', href: x.link || '#', style: 'text-decoration:none;color:inherit', on: { click: closeSheet } },
      h('div', { class: 'ico', style: x.readAt ? '' : 'background:var(--red-50);color:var(--red)' }, icon('bell')),
      h('div', { class: 'main' }, h('div', { class: 't', style: x.readAt ? 'font-weight:500' : '', text: x.text }), h('div', { class: 's', text: dtm(x.createdAt) }))))) : empty('No notifications.'));
    if (n.some(x => !x.readAt)) api('/api/notifications/read', { method: 'POST', body: {} }).then(() => $('#top .dot')?.remove()).catch(() => {});
  } catch (x) { s.render(errorBox(x)); }
}

async function staffAccount(view) {
  view.append(h('h2', { text: 'My account' }), h('div', { class: 'card' }, h('b', { text: S.user.name }), h('div', { class: 'muted sm', text: `${S.user.username} · ${S.user.role}` })));
  await agent.passkeySection(view);
  view.append(h('h3', { text: 'Security' }), h('button', { class: 'btn ghost', text: 'Change password', on: { click: agent.passwordForm } }));
}

async function signOut() {
  await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
  location.hash = '#/'; await boot();
}

let rendering = 0;
async function route() {
  const my = ++rendering;
  closeSheet();
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const [page, sub] = parts;

  if (page === 'link' && sub) { app.classList.add('out'); app.classList.remove('wide'); await renderLink(view, sub); return; }
  if (!S.user) { app.classList.add('out'); app.classList.remove('wide'); renderLogin(view, { onSignedIn: afterSignIn, username: sessionStorage.getItem('dsp-username') || '' }); return; }
  if (S.session.mfa) { app.classList.add('out'); renderMfa(view, S.session.mfa, async () => { await loadSession(); location.hash = '#/'; route(); }); return; }

  app.classList.remove('out');
  const staff = S.user.role !== 'agent';
  app.classList.toggle('wide', staff);
  header();
  const def = staff ? 'today' : 'home';
  const name = page || def;
  tabs(name);
  clear(view);
  const table = staff
    ? { today: mgr.today, map: mgr.mapView, punches: mgr.punches, requests: mgr.requests, team: mgr.team, admin: S.user.role === 'admin' ? admin : null, me: staffAccount }
    : { home: agent.home, schedule: agent.schedule, attendance: agent.attendance, leave: agent.leave, profile: agent.profile };
  const fn = table[name] || table[def];
  try {
    await fn(view, sub);
    if (my !== rendering) return;
    if (!staff && name === 'profile' || staff && name === 'me') view.append(h('button', { class: 'btn ghost', style: 'margin-top:16px', on: { click: signOut } }, icon('logout'), 'Sign out'));
  } catch (x) {
    if (my !== rendering) return;
    clear(view).append(errorBox(x), h('button', { class: 'btn ghost', style: 'margin-top:12px', text: 'Try again', on: { click: route } }));
  }
  view.focus({ preventScroll: true });
}

async function afterSignIn(r) {
  await loadSession();
  sessionStorage.removeItem('dsp-username');
  location.hash = '#/';
  await route();
  // Offer a passkey once to people who signed in with a password on a device that supports one.
  if (!r?.mfa && S.session.via === 'password' && !S.session.passkeys && S.session.passkeysEnabled && await platformAuthenticator()) {
    let dismissed = false; try { dismissed = localStorage.getItem('dsp-pk-offer') === S.user.username; } catch {}
    if (dismissed) return;
    const s = openSheet('Sign in faster');
    s.render([h('div', { class: 'ok', style: 'background:var(--ink)' }, icon('face', 44)), h('h1', { class: 'center', text: 'Use Face ID or your fingerprint next time?' }),
      h('p', { class: 'lead center', text: 'Save a passkey on this phone. You won’t need to type your password, and nobody can phish it.' })],
      [h('button', { class: 'btn primary', text: 'Save a passkey', on: { click: async () => { try { await addPasskey(guessDeviceLabel()); closeSheet(); toast('Passkey saved'); await loadSession(); } catch (x) { toast(x.message); } } } }),
       h('button', { class: 'btn link', text: 'Not now', on: { click: () => { try { localStorage.setItem('dsp-pk-offer', S.user.username); } catch {} closeSheet(); } } })]);
  }
}

async function boot() {
  try { await loadSession(); }
  catch (x) { clear(view).append(errorBox(x)); return; }
  await route();
}

window.addEventListener('hashchange', route);
window.addEventListener('rerender', route);
window.addEventListener('reauth', async () => { await loadSession().catch(() => {}); route(); });
boot();
