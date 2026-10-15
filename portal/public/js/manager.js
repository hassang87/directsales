import { api, h, clear, icon, pill, empty, spinner, note, field, errorBox, tm, dt, dtm, ago, dayLabel, bhToday, addDays, initials, gmaps, openSheet, closeSheet, confirmSheet, onSheetClose, toast, copy, S } from './core.js';

const refresh = () => window.dispatchEvent(new CustomEvent('rerender'));
const staleMs = () => (S.session?.staleMinutes || 30) * 60e3;
let teamFilter = '';
const tq = (sep = '?') => teamFilter ? `${sep}teamId=${teamFilter}` : '';

function teamChips(onChange) {
  if (S.teams.length < 2) return document.createTextNode('');
  const mk = (id, name) => h('button', { class: `chip ${String(teamFilter) === String(id) ? 'on' : ''}`, text: name, on: { click: () => { teamFilter = id; onChange(); } } });
  return h('div', { class: 'chips' }, mk('', 'All my teams'), S.teams.map(t => mk(t.id, t.name)));
}

/* ---------------- Today ---------------- */
export async function today(view) {
  view.append(spinner());
  const d = await api('/api/team/overview' + tq());
  clear(view);
  const c = d.counts;
  const stat = (n, label, href, warn) => h(href ? 'a' : 'div', { class: `stat ${warn && n ? 'warn' : ''}`, href, style: 'text-decoration:none;color:inherit' }, h('b', { text: n }), h('span', { text: label }));
  view.append(
    h('div', { class: 'row between', style: 'margin:4px 0 12px' }, h('h2', { style: 'margin:0', text: 'Today' }), h('span', { class: 'muted sm', text: dayLabel(d.date) })),
    teamChips(refresh),
    h('div', { class: 'stats' },
      stat(c.scheduled, 'Scheduled'), stat(c.onDuty, 'On duty now', '#/map'), stat(c.punchedOut, 'Punched out'),
      stat(c.noPunchRecorded, 'No punch-in recorded', null, true), stat(c.onLeave, 'On approved leave'), stat(c.off, 'Off today'),
      stat(c.pendingExceptions, 'Exceptions to review', '#/punches', true), stat(c.pendingLeave, 'Leave to decide', '#/requests', true),
      stat(c.pendingLocationRequests, 'Location requests open', '#/requests/location'), stat(c.staleLocations, 'Stale locations', '#/map', true)));
  const attn = [
    ...d.noPunch.map(n => h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('clock')), h('div', { class: 'main' }, h('div', { class: 't', text: `${n.name} · no punch-in recorded` }), h('div', { class: 's', text: `Shift started ${n.start}` })))),
    ...d.stale.map(n => h('a', { class: 'card item', href: '#/map', style: 'text-decoration:none;color:inherit' }, h('div', { class: 'ico', style: 'background:var(--amber-50);color:var(--amber)' }, icon('pin')), h('div', { class: 'main' }, h('div', { class: 't', text: `${n.name} · location is stale` }), h('div', { class: 's', text: n.lastAt ? `Last recorded ${ago(n.lastAt)}` : 'No location recorded this shift' })), icon('chev', 18)))
  ];
  view.append(h('h3', { text: 'Worth a look' }), attn.length ? h('div', { class: 'list' }, attn) : empty('Nothing needs attention right now.'),
    h('p', { class: 'muted sm', style: 'margin-top:14px', text: 'Counts are factual only. The portal does not rank, score or judge agents.' }));
}

/* ---------------- Map ---------------- */
let mapsPromise;
function loadMaps(key) {
  if (window.google?.maps?.importLibrary) return Promise.resolve();
  if (mapsPromise) return mapsPromise;
  mapsPromise = new Promise((res, rej) => {
    window.__dspMapsReady = () => res();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly&loading=async&libraries=marker&callback=__dspMapsReady`;
    s.async = true; s.onerror = () => { mapsPromise = null; rej(new Error('Google Maps could not load. Check the browser key and its website restriction.')); };
    document.head.append(s);
  });
  return mapsPromise;
}

export async function mapView(view) {
  view.append(h('h2', { text: 'Team map' }), spinner());
  const [agents, sites] = await Promise.all([api('/api/team/agents' + tq()), api('/api/team/work-locations' + tq())]);
  view.lastChild.remove();
  const onDuty = agents.filter(a => a.open);
  const selected = new Set();
  const detail = h('div');
  const mapBox = h('div', { class: 'map', role: 'region', 'aria-label': 'Map of on-duty agents' });
  view.append(teamChips(refresh), mapBox,
    h('p', { class: 'muted sm', style: 'margin-top:8px', text: `Markers show the latest recorded location of on-duty agents. Dashed amber means older than ${S.session.staleMinutes} minutes. Squares are assigned work locations. Nothing here is live tracking.` }),
    detail);

  const isStale = a => !a.lastLocation || Date.now() - a.lastLocation.at > staleMs();
  function showDetail(a) {
    clear(detail).append(h('div', { class: 'card', style: 'margin-top:12px' },
      h('div', { class: 'row between' }, h('div', {}, h('b', { style: 'font-size:16px', text: a.name }), h('div', { class: 'muted sm', text: `${a.team}${a.shift?.location ? ' · ' + a.shift.location : ''}` })),
        a.open.kind === 'exception' ? pill('On duty · exception', 'amber') : pill('On duty', 'green')),
      h('div', { class: 'kv', style: 'margin-top:12px' },
        h('div', {}, h('span', { text: 'Last recorded' }), h('b', {}, a.lastLocation ? pill(`${isStale(a) ? 'Stale · ' : ''}${ago(a.lastLocation.at)}`, isStale(a) ? 'amber' : 'blue') : 'No location yet')),
        a.lastLocation ? h('div', {}, h('span', { text: 'Accuracy' }), h('b', { text: `± ${Math.round(a.lastLocation.acc)} m · ${a.lastLocation.source.replace('_', ' ')}` })) : null,
        h('div', {}, h('span', { text: 'Punched in' }), h('b', { text: tm(a.open.punchInAt) }))),
      h('div', { class: 'btns', style: 'margin-top:12px' },
        h('button', { class: 'btn dark sm', disabled: a.pendingRequest, on: { click: () => requestLocation([a.id]) } }, icon('send', 16), a.pendingRequest ? 'Request pending' : 'Request fresh location'),
        a.lastLocation ? h('a', { class: 'btn ghost sm', href: gmaps(a.lastLocation.lat, a.lastLocation.lng), target: '_blank', rel: 'noopener', text: 'Open in Google Maps' }) : null)));
  }

  // The map itself (Google Maps when configured; otherwise the list below still works).
  if (S.session.maps) {
    try {
      await loadMaps(S.session.maps.key);
      const { Map } = await google.maps.importLibrary('maps');
      const { AdvancedMarkerElement } = await google.maps.importLibrary('marker');
      const map = new Map(mapBox, { center: { lat: 26.07, lng: 50.55 }, zoom: 10, mapId: S.session.maps.mapId, streetViewControl: false, mapTypeControl: false, fullscreenControl: false, clickableIcons: false });
      const bounds = new google.maps.LatLngBounds(); let n = 0;
      for (const w of sites) {
        const el = h('div', { class: 'mk wl', title: `${w.name} (assigned work location)` });
        new AdvancedMarkerElement({ map, position: { lat: w.lat, lng: w.lng }, content: el, title: w.name });
      }
      for (const a of onDuty.filter(x => x.lastLocation)) {
        const el = h('div', { class: `mk ${isStale(a) ? 'stale' : a.open.kind === 'exception' ? 'exc' : ''}`, text: initials(a.name) });
        const m = new AdvancedMarkerElement({ map, position: { lat: a.lastLocation.lat, lng: a.lastLocation.lng }, content: el, title: a.name, gmpClickable: true });
        m.addListener('click', () => showDetail(a));
        bounds.extend(m.position); n++;
      }
      if (n > 1) map.fitBounds(bounds, 60); else if (n === 1) { map.setCenter(bounds.getCenter()); map.setZoom(14); }
    } catch (x) { clear(mapBox).append(h('div', { style: 'padding:16px' }, errorBox(x))); }
  } else {
    clear(mapBox).append(h('div', { style: 'padding:20px;display:grid;place-items:center;height:100%;text-align:center' },
      h('div', {}, h('b', { text: 'Map not configured' }), h('p', { class: 'muted sm', style: 'margin-top:6px;max-width:320px', text: 'An administrator needs to add a Google Maps browser key (see README → Google Maps). The list below works without it.' }))));
    mapBox.style.height = 'auto';
  }

  const reqBtn = h('button', { class: 'btn dark sm inline', disabled: true, on: { click: () => requestLocation([...selected]) } }, icon('send', 16), 'Request location');
  view.append(h('h3', {}, `On duty (${onDuty.length})`, reqBtn));
  view.append(onDuty.length ? h('div', { class: 'list' }, onDuty.map(a => {
    const cb = h('input', { type: 'checkbox', 'aria-label': `Select ${a.name}`, on: { change: () => { cb.checked ? selected.add(a.id) : selected.delete(a.id); reqBtn.disabled = !selected.size; } } });
    return h('div', { class: 'card item' }, cb,
      h('button', { class: 'main', style: 'text-align:start', on: { click: () => { showDetail(a); detail.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } } },
        h('div', { class: 't', text: a.name }), h('div', { class: 's', text: a.lastLocation ? `Last recorded ${ago(a.lastLocation.at)} · ± ${Math.round(a.lastLocation.acc)} m` : 'No location recorded' })),
      a.pendingRequest ? pill('Asked', 'blue') : pill(isStale(a) ? 'Stale' : 'Fresh', isStale(a) ? 'amber' : 'green'),
      a.lastLocation ? h('a', { href: gmaps(a.lastLocation.lat, a.lastLocation.lng), target: '_blank', rel: 'noopener', 'aria-label': `Open ${a.name}'s location in Google Maps` }, icon('map', 18)) : null);
  })) : empty('Nobody is on duty right now.'));
}

function requestLocation(ids) {
  const s = openSheet('Request a fresh location');
  const reason = h('input', { maxlength: 200, value: 'Fresh location check' });
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: `Send to ${ids.length} agent${ids.length > 1 ? 's' : ''}`, on: { click: async () => {
    clear(err); btn.disabled = true;
    try {
      const r = await api('/api/team/location-requests', { method: 'POST', body: { userIds: ids, reason: reason.value } });
      closeSheet();
      toast(`${r.sent.length} sent${r.skipped.length ? `, ${r.skipped.length} skipped (${r.skipped.map(x => `${x.name || 'agent'}: ${x.why}`).join(', ')})` : ''}`);
      refresh();
    } catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Reason (the agent sees this)', reason), note('Only on-duty agents can be asked. They choose when to share, and the reading is labelled with its time.', 'pin'), err], [btn]);
}

/* ---------------- Punches & photos ---------------- */
export async function punches(view) {
  const date = sessionStorage.getItem('dsp-punch-date') || bhToday();
  const picker = h('input', { type: 'date', value: date, max: bhToday(), on: { change: () => { sessionStorage.setItem('dsp-punch-date', picker.value); refresh(); } } });
  view.append(h('h2', { text: 'Punches' }), teamChips(refresh), spinner());
  const [pending, rows] = await Promise.all([api('/api/team/attendance?pending=1' + tq('&')), api(`/api/team/attendance?date=${date}` + tq('&'))]);
  view.lastChild.remove();
  if (pending.length) view.append(h('h3', {}, 'Exceptions to review', h('small', { text: pending.length })), h('div', { class: 'list' }, pending.map(row)));
  view.append(h('h3', {}, 'Punch-ins', h('div', { style: 'width:170px' }, picker)));
  view.append(rows.length ? h('div', { class: 'list' }, rows.map(row)) : empty('No punch-ins recorded on this date.'));
  view.append(note('Opening a photo is recorded in the access log, with your name and the time.', 'eye'));
}
function row(a) {
  const exc = a.kind === 'exception';
  const thumb = a.hasPhoto ? h('img', { class: 'thumb', src: `/api/attendance/${a.id}/photo`, alt: `Punch-in photo of ${a.agent}`, loading: 'lazy' }) : h('div', { class: 'ico', style: exc ? 'background:var(--amber-50);color:var(--amber)' : '' }, icon(exc ? 'alert' : 'camera'));
  const tone = a.excStatus === 'pending' ? 'amber' : a.excStatus === 'approved' ? 'green' : a.excStatus === 'rejected' ? 'red' : '';
  return h('button', { class: 'card item', on: { click: () => openPunch(a) } }, thumb,
    h('div', { class: 'main' }, h('div', { class: 't', text: `${a.agent} · in ${tm(a.punchInAt)}${a.punchOutAt ? ` · out ${tm(a.punchOutAt)}` : ''}` }),
      h('div', { class: 's', text: [exc ? `Exception · ${a.excReason}` : a.synthetic ? 'Synthetic demo record · no photo' : 'Standard · selfie + location', a.punchInAt < Date.now() - 86400e3 ? dt(a.punchInAt) : null].filter(Boolean).join(' · ') })),
    exc ? pill(a.excStatus, tone) : icon(a.hasPhoto ? 'eye' : 'chev', 18));
}
function openPunch(a) {
  const s = openSheet(a.kind === 'exception' ? 'Attendance exception' : 'Punch-in photo');
  const err = h('div');
  const body = [
    h('div', { class: 'row', style: 'margin-bottom:12px' }, h('div', { class: 'avatar sm', text: initials(a.agent) }), h('div', {}, h('b', { text: a.agent }), h('div', { class: 'muted sm', text: dtm(a.punchInAt) }))),
    a.hasPhoto ? h('div', { class: 'camwrap' }, h('img', { src: `/api/attendance/${a.id}/photo`, alt: `Punch-in photo of ${a.agent}` }), h('div', { class: 'wm', text: `Viewed by ${S.user.name} · ${tm(Date.now())}` })) : null,
    h('div', { class: 'kv', style: 'margin-top:14px' },
      h('div', {}, h('span', { text: 'Punched in' }), h('b', { text: `${tm(a.punchInAt)} · Bahrain time` })),
      a.punchOutAt ? h('div', {}, h('span', { text: 'Punched out' }), h('b', { text: tm(a.punchOutAt) })) : null,
      h('div', {}, h('span', { text: 'Type' }), h('b', {}, a.kind === 'exception' ? pill('Exception', 'amber') : pill('Standard', 'green'))),
      a.in ? h('div', {}, h('span', { text: 'Location' }), h('b', {}, `± ${Math.round(a.in.acc)} m · `, h('a', { href: gmaps(a.in.lat, a.in.lng), target: '_blank', rel: 'noopener', text: 'Open in Google Maps' }))) : h('div', {}, h('span', { text: 'Location' }), h('b', { text: 'Not recorded' })),
      a.kind === 'exception' ? [h('div', {}, h('span', { text: 'Reason' }), h('b', { text: a.excReason })), h('div', {}, h('span', { text: 'Agent’s note' }), h('b', { text: a.excNote || 'None' })), h('div', {}, h('span', { text: 'Status' }), h('b', { text: a.excStatus }))] : null),
    a.synthetic ? note('Synthetic demo record: no real photo or person behind it.', 'alert', 'warn') : null,
    a.hasPhoto ? note('This view was recorded in the access log. The photo is supporting evidence only; no face matching is done.', 'eye') : null
  ];
  let foot = [];
  if (a.excStatus === 'pending') {
    const comment = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Required if you reject' });
    body.push(h('div', { style: 'margin-top:14px' }, field('Comment to the agent', comment)), note('Approved exceptions stay marked as exceptions in reports.', 'alert'), err);
    const decide = decision => async () => {
      clear(err);
      try { await api(`/api/team/attendance/${a.id}/decide`, { method: 'POST', body: { decision, comment: comment.value } }); closeSheet(); toast(`Exception ${decision}`); refresh(); }
      catch (x) { err.append(errorBox(x)); }
    };
    foot = [h('div', { class: 'btns' }, h('button', { class: 'btn ghost', text: 'Reject', on: { click: decide('rejected') } }), h('button', { class: 'btn green', on: { click: decide('approved') } }, icon('check', 18), 'Approve'))];
  }
  s.render(body, foot);
}

/* ---------------- Requests ---------------- */
export async function requests(view, sub) {
  const seg = sub === 'location' ? 'location' : 'leave';
  view.append(h('h2', { text: 'Requests' }), teamChips(refresh),
    h('div', { class: 'seg', style: 'margin-bottom:14px' },
      h('button', { class: seg === 'leave' ? 'on' : '', text: 'Leave', on: { click: () => location.hash = '#/requests' } }),
      h('button', { class: seg === 'location' ? 'on' : '', text: 'Location', on: { click: () => location.hash = '#/requests/location' } })), spinner());
  if (seg === 'location') {
    const rows = await api('/api/team/location-requests' + tq());
    view.lastChild.remove();
    view.append(rows.length ? h('div', { class: 'list' }, rows.map(r => h('div', { class: 'card item' }, h('div', { class: 'ico', style: 'background:var(--blue-50);color:var(--blue)' }, icon('send')),
      h('div', { class: 'main' }, h('div', { class: 't', text: r.agent }), h('div', { class: 's', text: `${r.reason} · by ${r.manager} · ${dtm(r.createdAt)}${r.answeredAt ? ` · answered in ${Math.max(1, Math.round((r.answeredAt - r.createdAt) / 60000))} min` : ''}` })),
      pill(r.status, { pending: 'amber', answered: 'green', expired: '', cancelled: '' }[r.status])))) : empty('No location requests yet.'),
      note('Only on-duty agents can be asked. Requests expire automatically and are cancelled when the agent punches out.', 'pin'));
    return;
  }
  const [pending, recent] = await Promise.all([api('/api/team/leave?status=pending' + tq('&')), api('/api/team/leave?status=all' + tq('&'))]);
  view.lastChild.remove();
  view.append(pending.length ? h('div', { class: 'list' }, pending.map(leaveRow)) : empty('No leave requests waiting.'));
  const decided = recent.filter(l => l.status !== 'pending').slice(0, 20);
  if (decided.length) view.append(h('h3', { text: 'Recently decided' }), h('div', { class: 'list' }, decided.map(leaveRow)));
}
function leaveRow(l) {
  const range = l.start === l.end ? dayLabel(l.start) : `${dayLabel(l.start)} – ${dayLabel(l.end)}`;
  return h('button', { class: 'card item', on: { click: () => leaveSheet(l) } }, h('div', { class: 'ico' }, icon(l.medical ? 'shield' : 'sun')),
    h('div', { class: 'main' }, h('div', { class: 't', text: `${l.agent} · ${l.type}` }), h('div', { class: 's', text: [range, l.portion !== 'full' ? l.portion : null, l.hasDocument ? 'document attached' : null].filter(Boolean).join(' · ') })),
    pill(l.status, { pending: 'amber', approved: 'green', rejected: 'red', cancelled: '' }[l.status]));
}
function leaveSheet(l) {
  const s = openSheet('Leave request');
  const err = h('div'), docBox = h('div');
  let blobUrl = null;
  onSheetClose(() => blobUrl && URL.revokeObjectURL(blobUrl));
  const openDoc = async () => {
    clear(docBox);
    try {
      const res = await fetch(`/api/leave/${l.id}/document`, { credentials: 'same-origin' });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error || 'The document could not be opened.'); }
      const blob = await res.blob(); blobUrl = URL.createObjectURL(blob);
      docBox.append(blob.type.startsWith('image/') ? h('img', { src: blobUrl, alt: 'Supporting document', style: 'width:100%;border-radius:12px;margin-top:10px' })
        : h('a', { class: 'btn ghost sm', href: blobUrl, target: '_blank', rel: 'noopener', style: 'margin-top:10px', text: 'Open the PDF' }));
    } catch (x) { docBox.append(errorBox(x)); }
  };
  const body = [h('h1', { text: l.agent }), h('p', { class: 'lead', text: `${l.type} leave · ${l.start === l.end ? dayLabel(l.start) : `${dayLabel(l.start)} – ${dayLabel(l.end)}`}${l.portion !== 'full' ? ` · ${l.portion}` : ''}` }),
    h('div', { class: 'kv', style: 'margin-top:16px' },
      h('div', {}, h('span', { text: 'Comment' }), h('b', { text: l.comment || 'None' })),
      h('div', {}, h('span', { text: 'Teammates already off' }), h('b', { text: l.overlap ? `${l.overlap} on overlapping days` : 'None' })),
      h('div', {}, h('span', { text: 'Status' }), h('b', { text: l.status })),
      l.decisionComment ? h('div', {}, h('span', { text: 'Decision comment' }), h('b', { text: l.decisionComment })) : null,
      l.hasDocument ? h('div', {}, h('span', { text: l.medical ? 'Medical document' : 'Document' }), h('b', {}, h('button', { class: 'pill', on: { click: openDoc } }, icon(l.medical ? 'lock' : 'doc', 13), 'View'))) : null),
    docBox,
    l.medical && l.hasDocument ? note('Medical documents open only for staff with the medical documents permission. Every attempt is logged.', 'lock') : null];
  let foot = [];
  if (l.status === 'pending') {
    const comment = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Required if you reject' });
    body.push(h('div', { style: 'margin-top:16px' }, field('Comment to the agent', comment)), err);
    const decide = decision => async () => {
      clear(err);
      try { await api(`/api/team/leave/${l.id}/decide`, { method: 'POST', body: { decision, comment: comment.value } }); closeSheet(); toast(`Leave ${decision}. The agent is notified.`); refresh(); }
      catch (x) { err.append(errorBox(x)); }
    };
    foot = [h('div', { class: 'btns' }, h('button', { class: 'btn ghost', text: 'Reject', on: { click: decide('rejected') } }), h('button', { class: 'btn green', on: { click: decide('approved') } }, icon('check', 18), 'Approve'))];
  }
  s.render(body, foot);
}

/* ---------------- Team: agents, schedule, announcements ---------------- */
export async function team(view, sub) {
  const tab = sub || 'agents';
  view.append(h('h2', { text: 'Team' }), h('div', { class: 'chips' },
    [['agents', 'Agents'], ['schedule', 'Schedule'], ['announcements', 'Announcements'], ['locations', 'Work locations']].map(([k, label]) => h('a', { class: `chip ${tab === k ? 'on' : ''}`, href: k === 'agents' ? '#/team' : `#/team/${k}`, text: label, style: 'text-decoration:none' }))));
  if (tab === 'schedule') return scheduleEditor(view);
  if (tab === 'announcements') return announcements(view);
  if (tab === 'locations') return workLocations(view);
  view.append(teamChips(refresh), h('button', { class: 'btn primary', style: 'margin-bottom:14px', on: { click: addAgent } }, icon('plus'), 'Add agent'), spinner());
  const agents = await api('/api/team/agents' + tq());
  view.lastChild.remove();
  view.append(agents.length ? h('div', { class: 'list' }, agents.map(a => h('button', { class: 'card item', on: { click: () => agentSheet(a) } },
    h('div', { class: 'avatar sm', text: initials(a.name) }),
    h('div', { class: 'main' }, h('div', { class: 't', text: a.name }), h('div', { class: 's', text: [a.employeeId, a.team, a.status === 'invited' ? 'not activated yet' : a.passkeys ? 'signs in with passkey' : 'password only'].filter(Boolean).join(' · ') })),
    a.status === 'deactivated' ? pill('Deactivated', 'red') : a.status === 'invited' ? pill('Invited', 'blue') : a.open ? pill('On duty', 'green') : a.shift?.kind === 'off' ? pill('Off') : pill('Off duty')))) : empty('No agents in your teams yet.'));
}

function linkResult(s, title, r) {
  s.render([h('h1', { text: title }),
    h('p', { class: 'lead', text: `Send this single-use link to the person privately (for example by WhatsApp or SMS). It expires ${dtm(r.expiresAt)}.` }),
    h('div', { class: 'linkbox', style: 'margin-top:14px', text: r.link }),
    note('Email delivery is not set up yet, so the portal shows the link instead of emailing it. Never send a password; the person chooses their own.', 'alert', 'warn')],
    [h('button', { class: 'btn primary', text: 'Copy link', on: { click: () => copy(r.link) } }), h('button', { class: 'btn ghost', text: 'Done', on: { click: () => { closeSheet(); refresh(); } } })]);
}
function addAgent() {
  const s = openSheet('Add agent');
  const name = h('input', { maxlength: 100, autocomplete: 'off' }), user = h('input', { maxlength: 40, autocapitalize: 'none', placeholder: 'e.g. agent.ali' }), emp = h('input', { maxlength: 40 }),
    mobile = h('input', { maxlength: 30, inputmode: 'tel' }), email = h('input', { type: 'email', maxlength: 200 });
  const teamSel = h('select', {}, S.teams.map(t => h('option', { value: t.id, text: t.name })));
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: 'Create and get invitation link', on: { click: async () => {
    clear(err); btn.disabled = true;
    try { const r = await api('/api/team/agents', { method: 'POST', body: { name: name.value, username: user.value, employeeId: emp.value, mobile: mobile.value, email: email.value, teamId: Number(teamSel.value) } }); linkResult(s, 'Agent created', r); }
    catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Full name', name), field('Username', user, 'Letters, numbers, dots and dashes. Used to sign in.'), field('Employee ID', emp), field('Mobile', mobile), field('Email (optional)', email), field('Team', teamSel), err], [btn]);
  name.focus();
}
function agentSheet(a) {
  const s = openSheet(a.name);
  const act = (label, fn, cls = 'ghost') => h('button', { class: `btn ${cls}`, text: label, on: { click: fn } });
  s.render([
    h('div', { class: 'row', style: 'margin-bottom:14px' }, h('div', { class: 'avatar', text: initials(a.name) }), h('div', {}, h('b', { style: 'font-size:17px', text: a.name }), h('div', { class: 'muted sm', text: `${a.username} · ${a.team}` }))),
    h('div', { class: 'kv' },
      h('div', {}, h('span', { text: 'Status' }), h('b', { text: a.status })),
      h('div', {}, h('span', { text: 'Employee ID' }), h('b', { text: a.employeeId || '—' })),
      h('div', {}, h('span', { text: 'Mobile' }), h('b', { text: a.mobile || '—' })),
      h('div', {}, h('span', { text: 'Passkeys' }), h('b', { text: String(a.passkeys) })),
      h('div', {}, h('span', { text: 'Today' }), h('b', { text: a.open ? `On duty since ${tm(a.open.punchInAt)}` : a.shift ? (a.shift.kind === 'off' ? 'Off day' : `Shift ${a.shift.start} – ${a.shift.end}`) : 'No shift' })))
  ], [
    a.status !== 'deactivated' ? act(a.status === 'invited' ? 'Resend invitation link' : 'Create password reset link', async () => {
      try { const r = await api(`/api/team/agents/${a.id}/link`, { method: 'POST', body: {} }); linkResult(s, r.kind === 'invite' ? 'New invitation link' : 'Password reset link', r); } catch (x) { toast(x.message); }
    }) : null,
    a.passkeys ? act('Remove passkeys (lost phone)', () => confirmSheet('Remove all passkeys?', `${a.name} will need to sign in with their password and add a new passkey.`, 'Remove passkeys', async () => { await api(`/api/team/agents/${a.id}/passkeys`, { method: 'DELETE' }); toast('Passkeys removed'); refresh(); })) : null,
    a.status === 'deactivated'
      ? act('Reactivate account', () => confirmSheet('Reactivate this account?', `${a.name} will be able to sign in again.`, 'Reactivate', async () => { await api(`/api/team/agents/${a.id}/status`, { method: 'POST', body: { active: true } }); toast('Account reactivated'); refresh(); }))
      : act('Deactivate account', () => confirmSheet('Deactivate this account?', `${a.name} is signed out everywhere immediately and can’t sign in. Their records are kept.`, 'Deactivate', async () => { await api(`/api/team/agents/${a.id}/status`, { method: 'POST', body: { active: false } }); toast('Account deactivated'); refresh(); }), 'link')
  ]);
}

async function scheduleEditor(view) {
  const startKey = 'dsp-sched-from';
  let from = sessionStorage.getItem(startKey);
  if (!from) { const t = bhToday(); const dow = new Date(t + 'T00:00:00Z').getUTCDay(); from = addDays(t, -dow); } // weeks start on Sunday
  const to = addDays(from, 6);
  const nav = (n) => () => { sessionStorage.setItem(startKey, addDays(from, n)); refresh(); };
  view.append(teamChips(refresh), h('div', { class: 'row between', style: 'margin-bottom:10px' },
    h('button', { class: 'btn ghost sm inline', on: { click: nav(-7) } }, icon('back', 16), 'Previous'),
    h('b', { text: `${dayLabel(from)} – ${dayLabel(to)}` }),
    h('button', { class: 'btn ghost sm inline', on: { click: nav(7) } }, 'Next', icon('chev', 16))), spinner());
  const d = await api(`/api/team/schedule?from=${from}&to=${to}` + tq('&'));
  view.lastChild.remove();
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const changes = new Map();
  const saveBtn = h('button', { class: 'btn dark sm inline', disabled: true, text: 'Save draft', on: { click: async () => {
    saveBtn.disabled = true;
    try { await api('/api/team/schedule', { method: 'PUT', body: { entries: [...changes.values()] } }); toast('Draft saved. Publish to show it to agents.'); refresh(); }
    catch (x) { toast(x.message); saveBtn.disabled = false; }
  } } });
  const pubBtn = h('button', { class: 'btn primary sm inline', text: 'Publish week', on: { click: () => confirmSheet('Publish this week?', 'Agents with changes are notified and see the new schedule straight away.', 'Publish', async () => {
    if (changes.size) await api('/api/team/schedule', { method: 'PUT', body: { entries: [...changes.values()] } });
    const r = await api('/api/team/schedule/publish', { method: 'POST', body: { from, to, teamId: teamFilter || undefined } });
    toast(`${r.published} entr${r.published === 1 ? 'y' : 'ies'} published`); refresh();
  }) } });
  const draftCount = d.shifts.filter(s => !s.published).length;
  view.append(h('div', { class: 'row wrap', style: 'margin-bottom:10px' }, saveBtn, pubBtn, draftCount ? pill(`${draftCount} unpublished`, 'amber') : pill('All published', 'green')));
  const locs = d.workLocations;
  const cell = (agent, date) => {
    const cur = d.shifts.find(s => s.userId === agent.id && s.date === date);
    const lv = d.leave.find(l => l.userId === agent.id && l.start <= date && l.end >= date);
    const kind = h('select', { 'aria-label': `${agent.name} ${date}` }, h('option', { value: '', text: '—' }), h('option', { value: 'shift', text: 'Shift' }), h('option', { value: 'off', text: 'Off' }));
    const st = h('input', { type: 'time', value: cur?.start || '16:00', 'aria-label': 'Start' }), en = h('input', { type: 'time', value: cur?.end || '00:00', 'aria-label': 'End' });
    const wl = h('select', { 'aria-label': 'Work location' }, h('option', { value: '', text: 'No location' }), locs.filter(w => w.teamId === agent.teamId).map(w => h('option', { value: w.id, text: w.name })));
    kind.value = cur?.kind || ''; wl.value = cur?.workLocationId || '';
    const times = h('div', { class: 'times' }, st, en);
    const box = h('div', { class: `cell ${cur && !cur.published ? 'draft' : ''}` }, kind, times, wl, lv ? h('div', { class: 'cell leave', text: `Leave (${lv.status})` }) : null);
    const sync = () => { const on = kind.value === 'shift'; times.hidden = !on; wl.hidden = !on; };
    const mark = () => { sync(); box.classList.add('draft'); changes.set(`${agent.id}:${date}`, { userId: agent.id, date, kind: kind.value || 'clear', start: st.value, end: en.value, workLocationId: wl.value ? Number(wl.value) : null }); saveBtn.disabled = false; };
    for (const el of [kind, st, en, wl]) el.addEventListener('change', mark);
    sync();
    return box;
  };
  view.append(d.agents.length ? h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { text: 'Agent' }), days.map(dd => h('th', { text: dayLabel(dd) })))),
    h('tbody', {}, d.agents.map(a => h('tr', {}, h('td', { text: a.name, style: 'font-weight:600;white-space:nowrap' }), days.map(dd => h('td', {}, cell(a, dd)))))))) : empty('No agents in this team.'),
    note('Overnight shifts are fine: an end time earlier than the start means the shift ends the next day. Yellow cells are drafts that agents can’t see yet.', 'cal'));
}

async function announcements(view) {
  view.append(h('button', { class: 'btn primary', style: 'margin-bottom:14px', on: { click: newAnnouncement } }, icon('plus'), 'New announcement'), spinner());
  const rows = await api('/api/team/announcements');
  view.lastChild.remove();
  view.append(rows.length ? h('div', { class: 'list' }, rows.map(a => h('div', { class: 'card ann' },
    h('div', { class: 'row between wrap' }, h('b', { text: a.title }), h('div', { class: 'row' }, a.pinned ? pill('Pinned') : null, a.priority === 'high' ? pill('Important', 'red') : null)),
    h('div', { class: 'body', text: a.body }),
    h('div', { class: 'sm muted', style: 'margin-top:8px', text: `${a.team} · ${a.author} · ${dt(a.createdAt)}${a.expiresAt ? ` · expires ${dt(a.expiresAt)}` : ''}` }),
    a.requiresAck ? h('div', { style: 'margin-top:8px' }, pill(`${a.acked} of ${a.total} acknowledged`, a.acked >= a.total ? 'green' : 'amber')) : null))) : empty('No announcements yet.'));
}
function newAnnouncement() {
  const s = openSheet('New announcement');
  const title = h('input', { maxlength: 120 }), body = h('textarea', { rows: 6, maxlength: 4000 });
  const teamSel = h('select', {}, S.user.role === 'admin' ? h('option', { value: '', text: 'Everyone' }) : null, S.teams.map(t => h('option', { value: t.id, text: t.name })));
  const prio = h('select', {}, h('option', { value: 'normal', text: 'Normal' }), h('option', { value: 'high', text: 'Important' }));
  const exp = h('select', {}, h('option', { value: '', text: 'Never' }), [3, 7, 14, 30].map(n => h('option', { value: n, text: `After ${n} days` })));
  const pinned = h('input', { type: 'checkbox' }), ack = h('input', { type: 'checkbox' });
  const err = h('div');
  const btn = h('button', { class: 'btn primary', text: 'Publish', on: { click: async () => {
    clear(err); btn.disabled = true;
    try { await api('/api/team/announcements', { method: 'POST', body: { title: title.value, body: body.value, teamId: teamSel.value || null, priority: prio.value, pinned: pinned.checked, requiresAck: ack.checked, expiresDays: exp.value || null } }); closeSheet(); toast('Announcement published'); refresh(); }
    catch (x) { err.append(errorBox(x)); btn.disabled = false; }
  } } });
  s.render([field('Title', title), field('Message', body), field('Audience', teamSel), field('Priority', prio), field('Remove it', exp),
    h('label', { class: 'check' }, pinned, 'Pin to the top'), h('label', { class: 'check' }, ack, 'Ask agents to acknowledge'), err], [btn]);
}

async function workLocations(view) {
  view.append(spinner());
  const rows = await api('/api/team/work-locations');
  view.lastChild.remove();
  const name = h('input', { maxlength: 80, placeholder: 'e.g. Seef Mall Kiosk' }), lat = h('input', { inputmode: 'decimal', placeholder: '26.2335' }), lng = h('input', { inputmode: 'decimal', placeholder: '50.5390' });
  const teamSel = h('select', {}, S.teams.map(t => h('option', { value: t.id, text: t.name })));
  const err = h('div');
  view.append(rows.length ? h('div', { class: 'list' }, rows.map(w => h('div', { class: 'card item' }, h('div', { class: 'ico' }, icon('pin')),
    h('div', { class: 'main' }, h('div', { class: 't', text: w.name }), h('div', { class: 's', text: `${S.teams.find(t => t.id === w.teamId)?.name || ''} · ${w.lat.toFixed(5)}, ${w.lng.toFixed(5)}` })),
    h('a', { href: gmaps(w.lat, w.lng), target: '_blank', rel: 'noopener', 'aria-label': 'Open in Google Maps' }, icon('map', 18))))) : empty('No work locations yet.'),
    h('h3', { text: 'Add a work location' }),
    h('div', { class: 'card' }, field('Name', name), h('div', { class: 'grid2', style: 'margin-top:0' }, field('Latitude', lat), field('Longitude', lng)), field('Team', teamSel),
      note('Tip: in Google Maps, press and hold the spot, then copy the two numbers shown.', 'pin'), err,
      h('button', { class: 'btn dark', style: 'margin-top:12px', text: 'Add location', on: { click: async () => {
        clear(err);
        try { await api('/api/team/work-locations', { method: 'POST', body: { name: name.value, lat: Number(lat.value), lng: Number(lng.value), teamId: Number(teamSel.value) } }); toast('Work location added'); refresh(); }
        catch (x) { err.append(errorBox(x)); }
      } } })));
}
