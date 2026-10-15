import { q } from '../db/index.js';

/* ---------- audit & access logs ---------- */
export function audit(actorId, action, target = null, detail = null) {
  q.run('INSERT INTO audit_log(actor_id, action, target, detail, at) VALUES (?, ?, ?, ?, ?)',
    actorId ?? null, action, target == null ? null : String(target), detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)), Date.now());
}
export function access(actorId, kind, subjectUserId, ref, allowed) {
  q.run('INSERT INTO access_log(actor_id, kind, subject_user_id, ref, allowed, at) VALUES (?, ?, ?, ?, ?, ?)',
    actorId, kind, subjectUserId ?? null, ref == null ? null : String(ref), allowed ? 1 : 0, Date.now());
}

/* ---------- notifications (never include leave types, reasons or medical details) ---------- */
export function notify(userId, text, link = null) {
  q.run('INSERT INTO notifications(user_id, text, link, created_at) VALUES (?, ?, ?, ?)', userId, text, link, Date.now());
}

/* ---------- in-memory rate limiter (single process; see README → Scaling) ---------- */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr);
  return true;
}
export function resetRateLimits() { buckets.clear(); }
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600e3) buckets.delete(k);
}, 600e3).unref();
