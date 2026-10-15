// WebAuthn (passkey) verification using only Node's built-in crypto.
// Supports ES256 (-7), EdDSA (-8) and RS256 (-257). Attestation is not requested ('none'),
// so device make/model is never collected; any attestation statement sent anyway is ignored.
import crypto from 'node:crypto';
import { decodeCbor } from './cbor.js';
import { sha256buf } from './security.js';

export class WebAuthnError extends Error {}
const bad = msg => { throw new WebAuthnError(msg); };
const b64u = buf => Buffer.from(buf).toString('base64url');
const fromB64u = s => { if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) bad('Malformed base64url'); return Buffer.from(s, 'base64url'); };

export const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 };

export function parseAuthData(buf) {
  if (buf.length < 37) bad('Authenticator data too short');
  const out = { rpIdHash: buf.subarray(0, 32), flags: buf[32], signCount: buf.readUInt32BE(33) };
  if (out.flags & FLAGS.AT) {
    if (buf.length < 55) bad('Attested credential data missing');
    let o = 37;
    out.aaguid = buf.subarray(o, o + 16); o += 16;
    const len = buf.readUInt16BE(o); o += 2;
    if (len > 1023 || o + len > buf.length) bad('Credential id length invalid');
    out.credentialId = buf.subarray(o, o + len); o += len;
    const { value, offset } = decodeCbor(buf, o);
    out.cose = value; out.coseEnd = offset;
  }
  return out;
}

export function coseToJwk(cose) {
  if (!(cose instanceof Map)) bad('Public key is not a COSE map');
  const kty = cose.get(1), alg = cose.get(3);
  if (kty === 2 && alg === -7) {
    if (cose.get(-1) !== 1) bad('Only P-256 EC keys are accepted');
    const x = cose.get(-2), y = cose.get(-3);
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) bad('Bad EC key');
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(x), y: b64u(y) } };
  }
  if (kty === 1 && alg === -8) {
    if (cose.get(-1) !== 6) bad('Only Ed25519 OKP keys are accepted');
    return { alg, jwk: { kty: 'OKP', crv: 'Ed25519', x: b64u(cose.get(-2)) } };
  }
  if (kty === 3 && alg === -257) {
    const n = cose.get(-1), e = cose.get(-2);
    if (!Buffer.isBuffer(n) || n.length < 256) bad('RSA keys must be at least 2048 bits');
    return { alg, jwk: { kty: 'RSA', n: b64u(n), e: b64u(e) } };
  }
  bad('Unsupported passkey algorithm');
}

function checkClientData(clientDataB64, type, expectedChallenge, origin) {
  const raw = fromB64u(clientDataB64);
  let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch { bad('clientDataJSON is not JSON'); }
  if (cd.type !== type) bad('Wrong ceremony type');
  if (typeof cd.challenge !== 'string' || cd.challenge !== expectedChallenge) bad('Challenge mismatch');
  if (cd.origin !== origin) bad('Origin mismatch');
  if (cd.crossOrigin === true) bad('Cross-origin ceremonies are not allowed');
  return raw;
}
function checkAuthData(ad, rpId) {
  if (!crypto.timingSafeEqual(ad.rpIdHash, sha256buf(rpId))) bad('Passkey belongs to a different site');
  if (!(ad.flags & FLAGS.UP)) bad('User presence was not confirmed');
  if (!(ad.flags & FLAGS.UV)) bad('Face ID, fingerprint or screen lock was not used');
}

/** Verifies navigator.credentials.create() output. `cred` is the JSON the browser app sends. */
export function verifyRegistration(cred, { challenge, origin, rpId }) {
  const r = cred?.response;
  if (!r || cred.type !== 'public-key') bad('Not a passkey response');
  checkClientData(r.clientDataJSON, 'webauthn.create', challenge, origin);
  const { value: att } = decodeCbor(fromB64u(r.attestationObject));
  if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) bad('Malformed attestation object');
  const ad = parseAuthData(att.get('authData'));
  checkAuthData(ad, rpId);
  if (!ad.credentialId) bad('No credential in response');
  if (b64u(ad.credentialId) !== cred.id) bad('Credential id mismatch');
  const { alg, jwk } = coseToJwk(ad.cose);
  crypto.createPublicKey({ key: jwk, format: 'jwk' }); // throws if the key is not usable
  return {
    credentialId: b64u(ad.credentialId), alg, jwk, signCount: ad.signCount,
    backupEligible: !!(ad.flags & FLAGS.BE), backedUp: !!(ad.flags & FLAGS.BS),
    transports: Array.isArray(r.transports) ? r.transports.filter(t => typeof t === 'string').slice(0, 6) : []
  };
}

/** Verifies navigator.credentials.get() output against a stored credential. */
export function verifyAuthentication(cred, stored, { challenge, origin, rpId }) {
  const r = cred?.response;
  if (!r || cred.type !== 'public-key') bad('Not a passkey response');
  const clientData = checkClientData(r.clientDataJSON, 'webauthn.get', challenge, origin);
  const authData = fromB64u(r.authenticatorData);
  const ad = parseAuthData(authData);
  checkAuthData(ad, rpId);
  const signed = Buffer.concat([authData, sha256buf(clientData)]);
  const key = crypto.createPublicKey({ key: JSON.parse(stored.public_key_jwk), format: 'jwk' });
  const sig = fromB64u(r.signature);
  let ok = false;
  if (stored.alg === -7) ok = crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, sig);
  else if (stored.alg === -257) ok = crypto.verify('sha256', signed, key, sig);
  else if (stored.alg === -8) ok = crypto.verify(null, signed, key, sig);
  if (!ok) bad('Passkey signature is not valid');
  // Synced passkeys report 0. A counter that goes backwards suggests a cloned authenticator.
  if (ad.signCount !== 0 || stored.sign_count !== 0) {
    if (ad.signCount <= stored.sign_count) bad('Passkey counter went backwards');
  }
  return { signCount: ad.signCount, backedUp: !!(ad.flags & FLAGS.BS), userHandle: r.userHandle || null };
}
