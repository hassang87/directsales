import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { randomToken } from './security.js';
import { fail } from './http.js';

/** Private files (selfies, leave documents) live outside the web root, with random names and owner-only permissions. */
export function ensureFilesDir() { fs.mkdirSync(config.filesDir, { recursive: true, mode: 0o700 }); }

export function saveFile(buf, ext) {
  ensureFilesDir();
  const name = `${randomToken(18)}.${ext}`;
  fs.writeFileSync(path.join(config.filesDir, name), buf, { mode: 0o600, flag: 'wx' });
  return name;
}
export function filePath(name) {
  if (!/^[A-Za-z0-9_-]+\.(jpg|png|pdf)$/.test(name || '')) fail(404, 'File not found.');
  return path.join(config.filesDir, name);
}
export function deleteFile(name) { try { if (name) fs.unlinkSync(filePath(name)); } catch {} }

/** Decodes a data: URL sent by the app. The real type is decided from the bytes, never from the claimed type. */
export function decodeDataUrl(s, maxBytes) {
  if (typeof s !== 'string') fail(400, 'A file is required.');
  const m = /^data:[\w/+.-]+;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  if (!m) fail(400, 'The file could not be read.');
  const buf = Buffer.from(m[1], 'base64');
  if (!buf.length) fail(400, 'The file is empty.');
  if (buf.length > maxBytes) fail(413, `The file is too large (max ${Math.round(maxBytes / 1048576)} MB).`);
  return buf;
}

export function sniff(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  return null;
}
/** A complete JPEG starts with SOI and ends with EOI (allowing trailing padding). */
export function isCompleteJpeg(buf) {
  if (sniff(buf) !== 'jpg') return false;
  const tail = buf.subarray(Math.max(0, buf.length - 64));
  for (let i = tail.length - 2; i >= 0; i--) if (tail[i] === 0xff && tail[i + 1] === 0xd9) return true;
  return false;
}
/** Rejects PDFs carrying scripts, launch actions or embedded files. */
export function pdfIsSafe(buf) {
  const s = buf.toString('latin1');
  return !/\/(JavaScript|JS|Launch|EmbeddedFile|EmbeddedFiles|RichMedia|XFA)\b/.test(s);
}
export const MIME = { jpg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

/** Deletes files no database row points at (e.g. after a crash mid-upload). */
export function sweepOrphans(referenced, olderThanMs = 3600e3) {
  ensureFilesDir();
  let n = 0;
  for (const f of fs.readdirSync(config.filesDir)) {
    if (referenced.has(f)) continue;
    const p = path.join(config.filesDir, f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > olderThanMs) { fs.unlinkSync(p); n++; } } catch {}
  }
  return n;
}
