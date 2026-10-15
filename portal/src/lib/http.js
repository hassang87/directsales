import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code || undefined; }
}
export const fail = (status, message, code) => { throw new HttpError(status, message, code); };

/* ---------- router ---------- */
export function createRouter() {
  const routes = [];
  const add = method => (pattern, opts, handler) => {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:(\w+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, opts, handler });
  };
  return {
    get: add('GET'), post: add('POST'), put: add('PUT'), delete: add('DELETE'),
    match(method, pathname) {
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== method) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        return { route: r, params };
      }
      return pathMatched ? { methodNotAllowed: true } : null;
    }
  };
}

/* ---------- request helpers ---------- */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) { req.resume(); return reject(new HttpError(413, 'That upload is too large.')); }
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'That upload is too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
export async function readJson(req, limit = 64 * 1024) {
  const type = (req.headers['content-type'] || '').split(';')[0].trim();
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  if (type !== 'application/json') fail(415, 'Send JSON.');
  try { const v = JSON.parse(buf.toString('utf8')); return v && typeof v === 'object' ? v : {}; }
  catch { fail(400, 'The request body is not valid JSON.'); }
}
export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('='); if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function cookie(name, value, { maxAge, httpOnly = true, path: p = '/' } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=Lax`;
  if (httpOnly) c += '; HttpOnly';
  if (config.secureCookies) c += '; Secure';
  if (maxAge !== undefined) c += `; Max-Age=${Math.floor(maxAge / 1000)}`;
  return c;
}
export function clientIp(req) {
  if (config.trustProxy) {
    const f = req.headers['x-forwarded-for'];
    if (f) return String(f).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---------- responses & security headers ---------- */
export function securityHeaders(res) {
  const maps = 'https://maps.googleapis.com https://maps.gstatic.com https://*.googleapis.com https://*.gstatic.com';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    `script-src 'self' ${maps}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`, // Google Maps injects inline styles
    `font-src 'self' https://fonts.gstatic.com`,
    `img-src 'self' data: blob: ${maps}`,
    `connect-src 'self' ${maps}`,
    "worker-src blob:",
    "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
  ].join('; '));
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), geolocation=(self), publickey-credentials-get=(self), publickey-credentials-create=(self), microphone=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}
export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
export function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // client-side routes fall back to the app shell
  const file = path.join(config.publicDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(config.publicDir)) return false;
  let stat; try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': rel === '/index.html' ? 'no-cache' : 'public, max-age=300'
  });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}
