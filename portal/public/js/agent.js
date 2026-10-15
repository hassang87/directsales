import { api, h, clear, icon, pill, empty, spinner, note, field, errorBox, tm, dt, dtm, dur, hms, dayLabel, bhToday, addDays, directions, openSheet, closeSheet, confirmSheet, toast, readFileAsDataUrl, S } from './core.js';
import { openPunchIn, openPunchOut, openShare } from './punch.js';
import { addPasskey, passkeysSupported, guessDeviceLabel } from './passkey.js';

let timer = null;
const refresh = () => window.dispatchEvent(new CustomEvent('rerender'));

export async function home(view) {
  view.append(spinner());
  const d = await api('/api/me/home');
  clear(view);
  clearInterval(timer);
  const open = d.open;
  const shift = d.shift;
  const statusPill = open ? (open.kind === 'exception' ? pill(open.excStatus === 'approved' ? 'On duty · exception approved' : 'On duty · exception in review', open.excStatus === 'approved' ? 'green' : 'amber') : pill('On duty', 'green')) : pill('Not punched in');

  if (d.locationRequest && open) view.append(h('div', { class: 'alert' },
    h('div', { class: 'ico' }, icon('pin')),
    h('div', { style: 'min-width:0' }, h('div', { class: 't', text: 'Location requested' }), h('div', { class: 's', text: `${d.locationRequest.manager} · ${d.locationRequest.reason}` })),
    h('button', { class: 'go', text: 'Share', on: { click: () => openShare(d.locationRequest, refresh) } })));

  const clock = h('div', { class: 'clock', text: open ? hms(Date.now() - open.punchInAt) : '' });
  if (open) timer = setInterval(() => { if (document.body.contains(clock)) clock.textContent = hms(Date.now() - open.punchInAt); else clearInterval(timer); }, 1000);

  view.append(h('section', { class: 'card hero' },
    h('div', { class: 'row between' }, statusPill, h('span', { class: 'muted sm', text: dayLabel(d.today) })),
    h('div', { class: 'shift' },
      h('div', { class: 'label', text: 'Today' }),
      shift ? (shift.kind === 'off' ? h('div', { class: 'big', text: 'Off day' }) : h('div', { class: 'big', text: `${shift.start} – ${shift.end}` })) : h('div', { class: 'big muted', style: 'font-size:22px', text: 'No shift scheduled' }),
      shift?.location ? h('div', { class: 'place' }, icon('pin', 16), shift.location.name,
        h('a', { href: directions(shift.location.lat, shift.location.lng), target: '_blank', rel: 'noopener', text: 'Directions' })) : null),
    open ? h('div', { class: 'timer' }, h('div', { class: 'label', style: 'color:inherit', text: 'On duty for' }), clock, h('div', { class: 'sm', text: `Punched in at ${tm(open.punchInAt)} · Bahrain time` })) : null,
    h('button', { class: `btn-punch ${open ? 'out' : ''}`, on: { click: () => open ? openPunchOut(open, refresh) : openPunchIn(refresh) } }, icon(open ? 'logout' : 'login', 22), open ? 'Punch Out' : 'Punch In'),
    h('p', { class: 'hint', text: open ? 'A fresh location is recorded when you punch out.' : 'Takes a live selfie and one fresh location reading.' })));

  view.append(h('div', { class: 'grid2' },
    h('button', { class: 'qa', on: { click: () => open ? openShare(null, refresh) : toast('Punch in first. Sharing is only for on-duty time.') } },
      h('div', { class: 'ico', style: 'background:var(--blue-50);color:var(--blue)' }, icon('send')), h('b', { text: 'Share my location' }), h('span', { text: open ? 'Send it now' : 'When on duty' })),
    h('button', { class: 'qa', on: { click: () => leaveForm(() => location.hash = '#/leave') } },
      h('div', { class: 'ico', style: 'background:var(--red-50);color:var(--red)' }, icon('doc')), h('b', { text: 'Request leave' }), h('span', { text: 'Annual, sick and more' })),
    h('a', { class: 'qa', href: '#/schedule', style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'ico', style: 'background:#F1EEFD;color:#5B3FD6' }, icon('cal')), h('b', { text: 'My schedule' }), h('span', { text: 'Shifts and off days' })),
    h('a', { class: 'qa', href: '#/attendance', style: 'text-decoration:none;color:inherit' },
      h('div', { class: 'ico', style: 'background:var(--green-50);color:var(--green)' }, icon('clock')), h('b', { text: 'Attendance' }), h('span', { text: 'History and photos' }))));

  view.append(h('div', { class: 'grid2', style: 'margin-top:10px' },
    h('div', { class: 'card mini' }, h('div', { class: 'label', text: 'Next off day' }), h('div', { class: 'v', text: d.nextOff ? dayLabel(d.nextOff) : 'Not scheduled' })),
    h('div', { class: 'card mini' }, h('div', { class: 'label', text: 'Upcoming leave' }),
      h('div', { class: 'v', text: d.leave.length ? `${dayLabel(d.leave[0].start)} · ${d.leave[0].status === 'approved' ? 'approved' : 'pending'}` : 'None' }))));

  view.append(h('h3', { text: 'Announcements' }));
  view.append(d.announcements.length ? h('div', { class: 'list' }, d.announcements.map(announcementCard)) : empty('No announcements right now.'));
}

function announcementCard(a) {
  const ack = h('button', { class: 'btn sm primary inline', style: 'margin-top:10px', text: 'I’ve read this', on: { click: async () => {
    ack.disabled = true;
    try { await api(`/api/announcements/${a.id}/ack`, { method: 'POST', body: {} }); ack.replaceWith(pill('Acknowledged', 'green')); }
    catch (x) { toast(x.message); ack.disabled = false; }
  } } });
  return h('div', { class: 'card ann' },
    h('div', { class: 'row between wrap' }, h('b', { text: a.title }),
      h('div', { class: 'row' }, a.pinned ? pill('Pinned') : null, a.priority === 'high' ? pill('Important', 'red') : null)),
    h('div', { class: 'body', text: a.body }),
    h('div', { class: 'sm muted', style: 'margin-top:8px', text: `${a.author} · ${dt(a.createdAt)}` }),
    a.requiresAck ? (a.acked ? h('div', { style: 'margin-top:10px' }, pill('Acknowledged', 'green')) : ack) : null);
}

export async function schedule(view) {
  view.append(h('h2', { text: 'My schedule' }), spinner());
  const from = bhToday(), to = addDays(from, 27);
  const d = await api(`/api/me/schedule?from=${from}&to=${to}`);
  view.lastChild.remove();
  const days = [];
  for (let i = 0; i <= 27; i++) days.push(addDays(from, i));
  const rows = days.map(date => {
    const s = d.shifts.find(x => x.date === date);
    const lv = d.leave.find(l => l.start <= date && l.end >= date);
    if (!s && !lv) return null;
    const cls = lv ? 'leave' : s?.kind === 'off' ? 'off' : '';
    const [wd, dd] = dayLabel(date).split(' ');
    return h('div', { class: `card sched ${cls} ${date === from ? 'today' : ''}` },
      h('div', { class: 'date' }, h('b', { text: dd }), h('span', { text: wd })), h('div', { class: 'bar' }),
      h('div', { class: 'main' },
        h('div', { class: 't', style: 'font-weight:700' },
          lv ? `${lv.type} leave${lv.portion && lv.portion !== 'full' ? ` (${lv.portion})` : ''}` : s.kind === 'off' ? 'Off day' : `${s.start} – ${s.end}`, ' ',
          lv ? pill(lv.status === 'approved' ? 'Approved' : 'Pending', lv.status === 'approved' ? 'blue' : 'amber') : null,
          date === from ? pill('Today', 'green') : null),
        h('div', { class: 's muted sm', style: 'margin-top:3px', text: lv ? (s?.kind === 'shift' ? `Scheduled shift ${s.start} – ${s.end}` : '') : s.kind === 'off' ? 'Enjoy your day' : (s.location?.name || '') })));
  }).filter(Boolean);
  view.append(rows.length ? h('div', { class: 'list' }, rows) : empty('No published schedule for the next four weeks yet.'));
  view.append(note('Only published schedules appear here. You get a notification when your manager publishes a change.', 'cal'));
}

export async function attendance(view) {
  view.append(h('h2', { text: 'Attendance' }), spinner());
  const rows = await api('/api/me/attendance');
  view.lastChild.remove();
  if (!rows.length) { view.append(empty('No attendance records yet.')); return; }
  view.append(h('div', { class: 'list' }, rows.map(a => {
    const thumb = a.hasPhoto ? h('img', { class: 'thumb', src: `/api/attendance/${a.id}/photo`, alt: 'Your punch-in selfie', loading: 'lazy' }) : h('div', { class: 'ico' }, icon(a.kind === 'exception' ? 'alert' : 'clock'));
    const status = a.kind === 'exception' ? pill(`Exception · ${a.excStatus}`, a.excStatus === 'approved' ? 'green' : a.excStatus === 'rejected' ? 'red' : 'amber') : (a.punchOutAt ? pill('Standard') : pill('Open', 'green'));
    return h('div', { class: 'card item' }, thumb, h('div', { class: 'main' },
      h('div', { class: 't', text: `${dt(a.punchInAt)} · ${tm(a.punchInAt)} – ${a.punchOutAt ? tm(a.punchOutAt) : 'now'}` }),
      h('div', { class: 's', text: [a.punchOutAt ? dur(a.punchOutAt - a.punchInAt) : 'On duty', a.excReason, a.excComment ? `Manager: ${a.excComment}` : null, a.synthetic ? 'Synthetic demo record' : null].filter(Boolean).join(' · ') })), status);
  })));
  view.append(note('Forgot to punch out, or a time is wrong? Tell your manager; they record corrections next to the original times, which are never overwritten.', 'clock'));
}

export async function leave(view) {
  view.append(h('h2', { text: 'Leave' }),
    h('button', { class: 'btn primary', on: { click: () => leaveForm(refresh) } }, icon('plus'), 'New leave request'),
    note('Notifications never mention your leave type or reason. Medical documents are only visible to specifically authorised staff.'),
    h('h3', { text: 'My requests' }), spinner());
  const rows = await api('/api/me/leave');
  view.lastChild.remove();
  if (!rows.length) { view.append(empty('You have no leave requests.')); return; }
  view.append(h('div', { class: 'list' }, rows.map(l => {
    const tone = { approved: 'green', rejected: 'red', cancelled: '', pending: 'amber' }[l.status];
    return h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon(l.type === 'Sick' ? 'shield' : 'sun')),
      h('div', { class: 'main' }, h('div', { class: 't', text: `${l.type} leave` }),
        h('div', { class: 's', text: [l.start === l.end ? dayLabel(l.start) : `${dayLabel(l.start)} – ${dayLabel(l.end)}`, l.portion !== 'full' ? l.portion : null, l.decisionComment ? `Manager: ${l.decisionComment}` : null].filter(Boolean).join(' · ') })),
      h('div', { class: 'stack', style: 'align-items:flex-end' }, pill(l.status[0].toUpperCase() + l.status.slice(1), tone),
        l.status === 'pending' ? h('button', { class: 'pill', text: 'Cancel', on: { click: () => confirmSheet('Cancel this request?', 'Your manager will no longer see it.', 'Cancel request', async () => { await api(`/api/leave/${l.id}/cancel`, { method: 'POST', body: {} }); refresh(); }) } }) : null));
  })));
}

export async function leaveForm(after) {
  const s = openSheet('Request leave');
  s.render([spinner()]);
  let types;
  try { types = await api('/api/leave/types'); } catch (x) { s.render([errorBox(x)]); return; }
  const type = h('select', {}, types.map(t => h('option', { value: t.id, text: t.name })));
  const from = h('input', { type: 'date', value: addDays(bhToday(), 1), min: bhToday() });
  const to = h('input', { type: 'date', value: addDays(bhToday(), 1), min: bhToday() });
  const portion = h('select', {}, h('option', { value: 'full', text: 'Full day(s)' }), h('option', { value: 'morning', text: 'Morning only' }), h('option', { value: 'afternoon', text: 'Afternoon only' }));
  const comment = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Optional' });
  const doc = h('input', { type: 'file', accept: 'application/pdf,image/jpeg,image/png' });
  const docHelp = h('span', { class: 'help' });
  const syncType = () => { const t = types.find(x => String(x.id) === type.value); docHelp.textContent = t?.requiresDocument ? 'Required for this leave type. PDF, JPG or PNG, up to 5 MB.' : 'Optional. PDF, JPG or PNG, up to 5 MB.'; };
  type.addEventListener('change', syncType); syncType();
  from.addEventListener('change', () => { if (to.value < from.value) to.value = from.value; });
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: 'Submit request', on: { click: async () => {
    clear(err); btn.disabled = true;
    try {
      let document;
      if (doc.files[0]) { if (doc.files[0].size > 5 * 1048576) throw new Error('The document is larger than 5 MB.'); document = await readFileAsDataUrl(doc.files[0]); }
      await api('/api/leave', { method: 'POST', body: { typeId: Number(type.value), start: from.value, end: to.value, portion: portion.value, comment: comment.value, document } });
      closeSheet(); toast('Leave request sent to your manager'); after?.();
    } catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Leave type', type), h('div', { class: 'grid2', style: 'margin-top:0' }, field('From', from), field('To', to)), field('Duration', portion, 'Half days are for a single date.'),
    field('Comment', comment), h('div', { class: 'field' }, h('label', { text: 'Supporting document' }), doc, docHelp),
    note('Notifications never mention your leave type or reason.'), err], [btn]);
}

export async function profile(view) {
  const u = S.user;
  view.append(h('div', { class: 'card', style: 'display:flex;flex-direction:column;align-items:center;padding:22px' },
    h('div', { class: 'avatar', style: 'width:68px;height:68px;font-size:22px', text: u.name.split(' ').map(w => w[0]).slice(0, 2).join('') }),
    h('div', { style: 'font-weight:800;font-size:19px;margin-top:10px', text: u.name }),
    h('div', { class: 'muted sm', text: [u.employeeId, u.team, u.username].filter(Boolean).join(' · ') })));
  await passkeySection(view);
  view.append(h('h3', { text: 'Your data' }), h('div', { class: 'list' },
    h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('pin')), h('div', { class: 'main' }, h('div', { class: 't', text: 'How your location is used' }), h('div', { class: 's', text: 'Recorded only when you punch in or out, or when you share it. Never in the background, never off duty. Colleagues never see it.' }))),
    h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('camera')), h('div', { class: 'main' }, h('div', { class: 't', text: 'Who sees your punch-in photo' }), h('div', { class: 's', text: 'You and your team’s authorised managers. Every view is logged. No face recognition is used.' })))));
  view.append(h('h3', { text: 'Security' }), h('button', { class: 'btn ghost', text: 'Change password', on: { click: passwordForm } }));
}

export async function passkeySection(view) {
  const box = h('div', { class: 'list' });
  view.append(h('h3', { text: 'Passkeys' }), box);
  const draw = list => {
    clear(box);
    if (!list.length) box.append(h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('key')), h('div', { class: 'main' }, h('div', { class: 't', text: 'No passkey yet' }), h('div', { class: 's', text: 'Add one to sign in with Face ID, fingerprint or your screen lock instead of typing a password.' }))));
    for (const p of list) box.append(h('div', { class: 'card item' }, h('div', { class: 'ico', style: 'background:var(--green-50);color:var(--green)' }, icon('key')),
      h('div', { class: 'main' }, h('div', { class: 't', text: p.label }), h('div', { class: 's', text: `Added ${dt(p.createdAt)}${p.lastUsedAt ? ` · last used ${dtm(p.lastUsedAt)}` : ''}${p.synced ? ' · synced' : ''}` })),
      h('button', { class: 'pill', text: 'Remove', on: { click: () => confirmSheet('Remove this passkey?', `“${p.label}” will no longer sign you in. You can still use your password.`, 'Remove passkey', async () => { const r = await api(`/api/passkeys/${p.id}`, { method: 'DELETE' }); draw(r.passkeys); toast('Passkey removed'); }) } })));
    if (passkeysSupported() && S.session?.passkeysEnabled) box.append(h('button', { class: 'btn ghost', on: { click: async e => {
      e.currentTarget.disabled = true;
      try { const r = await addPasskey(guessDeviceLabel()); draw(r.passkeys); toast('Passkey saved'); }
      catch (x) { toast(x.message); e.target.disabled = false; }
    } } }, icon('key', 18), 'Add a passkey on this device'));
    else box.append(note(window.isSecureContext ? 'This browser doesn’t support passkeys.' : 'Passkeys need the portal’s secure (HTTPS) address.', 'key'));
  };
  try { draw(await api('/api/passkeys')); } catch (x) { box.append(errorBox(x)); }
}

export function passwordForm() {
  const s = openSheet('Change password');
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: 'Save new password', on: { click: async () => {
    clear(err);
    if (n1.value !== n2.value) { err.append(errorBox(new Error('The new passwords don’t match.'))); return; }
    btn.disabled = true;
    try { await api('/api/me/password', { method: 'POST', body: { current: cur.value, next: n1.value } }); closeSheet(); toast('Password changed. Other devices were signed out.'); }
    catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Current password', cur), field('New password', n1, 'At least 10 characters.'), field('Type it again', n2), err], [btn]);
}
