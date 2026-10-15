// Shared helpers. Data is always inserted as text (no innerHTML for data); only fixed icon markup uses innerHTML.

export const S = { session: null, user: null, csrf: null, teams: [] };

export class ApiError extends Error { constructor(msg, status, code) { super(msg); this.status = status; this.code = code; } }

export async function api(path, { method = 'GET', body } = {}) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  if (method !== 'GET' && S.csrf) opts.headers['X-CSRF-Token'] = S.csrf;
  let res;
  try { res = await fetch(path, opts); }
  catch { throw new ApiError('You seem to be offline. Check your connection and try again.', 0, 'offline'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data.code === 'signed_out' || data.code === 'mfa_required') window.dispatchEvent(new CustomEvent('reauth'));
    throw new ApiError(data.error || 'Something went wrong. Try again.', res.status, data.code);
  }
  return data;
}

/* ---------- DOM ---------- */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);

const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  cal: '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.6c2 .6 3.5 2.4 3.5 5.4"/>',
  pin: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  map: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13.5" r="3.5"/>',
  bell: '<path d="M6 16v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  mega: '<path d="M3 10v4h4l8 5V5L7 10z"/><path d="M18.5 9a4 4 0 0 1 0 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  login: '<path d="M10 17l5-5-5-5M15 12H3"/><path d="M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5"/>',
  logout: '<path d="M14 7l5 5-5 5M19 12H8"/><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5"/>',
  send: '<path d="M3 11l18-8-8 18-2-8z"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M10.8 12.2 20 3M17 6l3 3M14 9l2 2"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M9 9.5v1.5M15 9.5v1.5M12 9.5v4h-1M9 16c1.5 1 4.5 1 6 0"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};
export function icon(name, size = 20) {
  const span = document.createElement('span');
  span.style.display = 'inline-flex';
  span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

/* ---------- time (always Bahrain) ---------- */
const TZ = 'Asia/Bahrain';
const fT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const fD = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const fDT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
export const tm = ms => fT.format(ms);
export const dt = ms => fD.format(ms);
export const dtm = ms => fDT.format(ms);
export const bhToday = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
export const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const dayLabel = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
export const dur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`; };
export const hms = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return [s / 3600, (s % 3600) / 60, s % 60].map(v => String(Math.floor(v)).padStart(2, '0')).join(':'); };
export const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`; const hh = Math.floor(m / 60); return hh < 24 ? `${hh} h ${m % 60} min ago` : dtm(ms); };
export const initials = name => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
export const gmaps = (lat, lng) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`;
export const directions = (lat, lng) => `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;

/* ---------- UI bits ---------- */
let toastTimer;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}
export function pill(text, tone = '') { return h('span', { class: `pill ${tone}` }, h('i'), text); }
export const empty = text => h('div', { class: 'card empty' }, text);
export const spinner = () => h('div', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });
export function note(text, ic = 'shield', tone = '') { return h('div', { class: `note ${tone}` }, icon(ic, 18), h('span', {}, text)); }
export function field(label, input, help) {
  const id = input.id || ('f' + Math.random().toString(36).slice(2, 8));
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, help ? h('span', { class: 'help', text: help }) : null);
}
export function errorBox(e) { return note(e.message || String(e), 'alert', 'err'); }
export async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select the text and copy it'); }
}

/* ---------- full-screen sheet ---------- */
const cleanups = [];
export function onSheetClose(fn) { cleanups.push(fn); }
export function openSheet(title, { steps = null, step = 0 } = {}) {
  const sheet = $('#sheet');
  clear(sheet);
  const body = h('div', { class: 'sh-body' }), foot = h('div', { class: 'sh-foot' });
  const top = h('div', { class: 'sh-top' },
    h('button', { class: 'iconbtn', 'aria-label': 'Close', on: { click: closeSheet } }, icon('x', 18)),
    h('div', { class: 'ttl', id: 'sheetTitle', text: title }), h('div', { style: 'width:38px' }));
  const stepsEl = h('div', { class: 'steps' });
  sheet.append(top, stepsEl, body, foot);
  sheet.classList.add('open');
  const api = {
    body, foot,
    setSteps(n, total) { clear(stepsEl); if (total) for (let i = 0; i < total; i++) stepsEl.append(h('i', { class: i <= n ? 'on' : '' })); },
    render(bodyKids, footKids = []) { clear(body); clear(foot); add(body, [bodyKids]); add(foot, [footKids]); body.scrollTop = 0; },
    close: closeSheet
  };
  if (steps) api.setSteps(step, steps);
  setTimeout(() => top.querySelector('button').focus(), 50);
  return api;
}
export function closeSheet() {
  while (cleanups.length) { try { cleanups.pop()(); } catch {} }
  $('#sheet').classList.remove('open');
  window.dispatchEvent(new CustomEvent('sheetclosed'));
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('#sheet').classList.contains('open')) closeSheet(); });

/** In-page confirmation (the browser's confirm() is not used). */
export function confirmSheet(title, text, okLabel, onOk, tone = 'primary') {
  const s = openSheet(title);
  const err = h('div');
  s.render([h('h1', { text: title }), h('p', { class: 'lead', text }), err], [
    h('button', { class: `btn ${tone}`, text: okLabel, on: { click: async e => { e.target.disabled = true; try { await onOk(); closeSheet(); } catch (x) { clear(err).append(errorBox(x)); e.target.disabled = false; } } } }),
    h('button', { class: 'btn ghost', text: 'Cancel', on: { click: closeSheet } })
  ]);
}
export function readFileAsDataUrl(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('The file could not be read.')); r.readAsDataURL(file); });
}
