// Passkey (WebAuthn) helpers for the browser.
import { api } from './core.js';

const toBuf = b64u => Uint8Array.from(atob(b64u.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64u.length / 4) * 4, '=')), c => c.charCodeAt(0)).buffer;
const toB64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
export async function platformAuthenticator() {
  try { return passkeysSupported() && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch { return false; }
}
function friendly(e) {
  if (e?.name === 'NotAllowedError') return new Error('The passkey prompt was closed or timed out.');
  if (e?.name === 'InvalidStateError') return new Error('This device already has a passkey for your account.');
  if (e?.name === 'SecurityError') return new Error('Passkeys need the portal’s secure web address (HTTPS).');
  return e instanceof Error ? e : new Error('Passkey failed.');
}

export async function signInWithPasskey() {
  const o = await api('/api/passkeys/login/options', { method: 'POST', body: {} });
  let cred;
  try {
    cred = await navigator.credentials.get({ publicKey: {
      challenge: toBuf(o.challenge), rpId: o.rpId, userVerification: o.userVerification, timeout: o.timeout, allowCredentials: []
    } });
  } catch (e) { throw friendly(e); }
  if (!cred) throw new Error('No passkey was chosen.');
  const r = cred.response;
  return api('/api/passkeys/login/verify', { method: 'POST', body: { credential: {
    id: cred.id, type: cred.type,
    response: { clientDataJSON: toB64u(r.clientDataJSON), authenticatorData: toB64u(r.authenticatorData), signature: toB64u(r.signature), userHandle: r.userHandle ? toB64u(r.userHandle) : null }
  } } });
}

export async function addPasskey(label) {
  const o = await api('/api/passkeys/register/options', { method: 'POST', body: {} });
  let cred;
  try {
    cred = await navigator.credentials.create({ publicKey: {
      ...o,
      challenge: toBuf(o.challenge),
      user: { ...o.user, id: toBuf(o.user.id) },
      excludeCredentials: o.excludeCredentials.map(c => ({ ...c, id: toBuf(c.id) }))
    } });
  } catch (e) { throw friendly(e); }
  const r = cred.response;
  return api('/api/passkeys/register/verify', { method: 'POST', body: { label, credential: {
    id: cred.id, type: cred.type,
    response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] }
  } } });
}

export function guessDeviceLabel() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'This device';
}
