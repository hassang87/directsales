import { fail } from './http.js';

export function str(v, name, { min = 1, max = 200, optional = false } = {}) {
  if (v == null || v === '') { if (optional) return null; fail(400, `${name} is required.`); }
  if (typeof v !== 'string') fail(400, `${name} must be text.`);
  const s = v.trim();
  if (s.length < min) { if (optional && !s.length) return null; fail(400, `${name} is required.`); }
  if (s.length > max) fail(400, `${name} is too long (max ${max} characters).`);
  return s;
}
export function int(v, name, { optional = false } = {}) {
  if (v == null || v === '') { if (optional) return null; fail(400, `${name} is required.`); }
  const n = Number(v);
  if (!Number.isInteger(n)) fail(400, `${name} must be a whole number.`);
  return n;
}
export function oneOf(v, name, options) {
  if (!options.includes(v)) fail(400, `${name} must be one of: ${options.join(', ')}.`);
  return v;
}
/** Validates a browser geolocation reading. Coordinates are never invented: missing means missing. */
export function reading(body) {
  const lat = Number(body.lat), lng = Number(body.lng), acc = Number(body.acc);
  if (![lat, lng, acc].every(Number.isFinite)) fail(400, 'A fresh location reading is required.', 'location_required');
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180 || acc <= 0 || acc > 100000) fail(400, 'That location reading is not valid.', 'location_invalid');
  return { lat, lng, acc: Math.round(acc) };
}
export const username = v => {
  const s = str(v, 'Username', { min: 3, max: 40 }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(s)) fail(400, 'Usernames can use letters, numbers, dots, dashes and underscores.');
  return s;
};
export const email = v => {
  const s = str(v, 'Email', { max: 200, optional: true });
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'That email address doesn’t look right.');
  return s;
};
