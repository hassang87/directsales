// Test harness: a real HTTP server on a random port with a fresh database. Nothing external is contacted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-test-'));
process.env.APP_MODE = 'test';
process.env.DATA_DIR = DATA;
process.env.SKIP_DOTENV = '1';
process.env.APP_ORIGIN = 'http://localhost:0'; // replaced after listen
process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

let ORIGIN;
export async function start() {
  const port = await new Promise(res => { const s = (awaitImport.net).createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  ORIGIN = `http://localhost:${port}`;
  process.env.APP_ORIGIN = ORIGIN;
  const { config } = await import('../src/config.js');
  Object.assign(config, { origin: ORIGIN, rpId: 'localhost' });
  const db = await import('../src/db/index.js');
  db.openDb();
  const { seedDemo } = await import('../scripts/seed-demo.js');
  seedDemo();
  (await import('../src/lib/storage.js')).ensureFilesDir();
  const { createServer } = await import('../src/app.js');
  const server = createServer();
  await new Promise(res => server.listen(port, res));
  return { server, db, config, origin: ORIGIN };
}
const awaitImport = { net: await import('node:net') };

/** A tiny browser: keeps cookies and the CSRF token, sends the Origin header like a browser would. */
export class Client {
  constructor() { this.jar = {}; this.csrf = null; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, url, body, { origin = ORIGIN, csrf = true, raw = false } = {}) {
    const headers = { Cookie: this.cookieHeader() };
    if (method !== 'GET') { headers.Origin = origin; if (csrf && this.csrf) headers['X-CSRF-Token'] = this.csrf; }
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(ORIGIN + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0/.test(c) || v === '') delete this.jar[k]; else this.jar[k] = v;
    }
    if (raw) return res;
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }
  get(u, o) { return this.req('GET', u, undefined, o); }
  post(u, b = {}, o) { return this.req('POST', u, b, o); }
  put(u, b = {}, o) { return this.req('PUT', u, b, o); }
  del(u, o) { return this.req('DELETE', u, undefined, o); }
  async refresh() { const s = await this.get('/api/session'); this.csrf = s.data.csrf || null; return s.data; }
  async login(username, password) {
    const r = await this.post('/api/auth/login', { username, password });
    await this.refresh();
    return r;
  }
}

export const fakeJpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(400), Buffer.from([0xff, 0xd9])]);
export const dataUrl = (buf, type = 'image/jpeg') => `data:${type};base64,${buf.toString('base64')}`;

/** A software passkey authenticator (P-256), built from the WebAuthn spec, used only in tests. */
export class SoftAuthenticator {
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey; this.jwk = publicKey.export({ format: 'jwk' });
    this.credId = crypto.randomBytes(16);
    this.counter = 0;
  }
  async create(options, origin, { cbor }) {
    const rpIdHash = crypto.createHash('sha256').update(options.rp.id).digest();
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.jwk.x, 'base64url')], [-3, Buffer.from(this.jwk.y, 'base64url')]]);
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const authData = Buffer.concat([rpIdHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), len, this.credId, cbor.encodeCbor(cose)]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }));
    const att = cbor.encodeCbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return { id: this.credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: clientData.toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal'] } };
  }
  get(options, origin, { userHandle = null, flags = 0x05 } = {}) {
    this.counter++;
    const rpIdHash = crypto.createHash('sha256').update(options.rpId).digest();
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    const authData = Buffer.concat([rpIdHash, Buffer.from([flags]), cnt]);
    const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }));
    const sig = crypto.sign('sha256', Buffer.concat([authData, crypto.createHash('sha256').update(clientData).digest()]), this.priv);
    return { id: this.credId.toString('base64url'), type: 'public-key', response: { clientDataJSON: clientData.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url'), userHandle } };
  }
}
export const LOC = { lat: 26.2336, lng: 50.5391, acc: 12 };
