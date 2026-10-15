// Bahrain observes UTC+3 all year (no daylight saving), so business dates are a fixed offset from UTC.
const OFFSET = 3 * 3600e3;

/** 'YYYY-MM-DD' in Asia/Bahrain for a UTC timestamp. */
export const bhDate = (ms = Date.now()) => new Date(ms + OFFSET).toISOString().slice(0, 10);
/** 'HH:MM' in Asia/Bahrain. */
export const bhTime = (ms = Date.now()) => new Date(ms + OFFSET).toISOString().slice(11, 16);
/** UTC timestamp for a Bahrain date + 'HH:MM'. */
export const bhToUtc = (date, hhmm = '00:00') => Date.parse(`${date}T${hhmm}:00Z`) - OFFSET;
export function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
export const isTime = s => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
/** Start and end (UTC ms) of a shift; an end at or before the start means it ends the next day. */
export function shiftWindow(date, start, end) {
  const s = bhToUtc(date, start);
  let e = bhToUtc(date, end);
  if (e <= s) e += 24 * 3600e3;
  return [s, e];
}
