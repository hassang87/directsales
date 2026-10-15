import { api, h, clear, icon, note, field, errorBox, copy, S } from './core.js';
import { passkeysSupported, signInWithPasskey } from './passkey.js';

const brand = sub => h('div', { class: 'brand' }, h('div', { class: 'logo', text: 'DS' }), h('div', {}, h('b', { text: 'Direct Sales Portal' }), h('span', { text: sub })));

export function renderLogin(view, { onSignedIn, username = '' }) {
  clear(view);
  const err = h('div');
  const u = h('input', { autocomplete: 'username webauthn', autocapitalize: 'none', spellcheck: false, value: username, placeholder: 'e.g. agent.noor' });
  const p = h('input', { type: 'password', autocomplete: 'current-password' });
  const submit = h('button', { class: 'btn primary', type: 'submit', text: 'Sign in' });
  const form = h('form', { on: { submit: async e => {
    e.preventDefault(); clear(err); submit.disabled = true;
    try { const r = await api('/api/auth/login', { method: 'POST', body: { username: u.value, password: p.value } }); await onSignedIn(r); }
    catch (x) { err.append(errorBox(x)); submit.disabled = false; p.select(); }
  } } }, field('Username', u), field('Password', p), submit);

  const canPasskey = S.session?.passkeysEnabled && passkeysSupported();
  const pkBtn = h('button', { class: 'btn primary', style: 'min-height:60px;font-size:17px', on: { click: async () => {
    clear(err); pkBtn.disabled = true;
    try { const r = await signInWithPasskey(); await onSignedIn(r); }
    catch (x) { err.append(errorBox(x)); pkBtn.disabled = false; }
  } } }, icon('face', 24), 'Sign in with a passkey');

  view.append(h('div', { class: 'login' },
    brand('Bahrain field team'),
    h('h1', { text: 'Welcome back' }),
    h('p', { class: 'lead', text: 'Sign in to punch in, check your schedule and request leave.' }),
    canPasskey ? [pkBtn, h('p', { class: 'sm muted center', style: 'margin-top:10px', text: 'Uses Face ID, fingerprint or your phone’s screen lock.' }), h('div', { class: 'or', text: 'or use your password' })] : null,
    err, form,
    h('p', { class: 'sm muted center', style: 'margin-top:16px', text: 'Forgot your password? Ask your manager for a reset link.' }),
    S.session?.demo ? note('Demo sign-ins: agent.noor / Demo-Agent-2026!, demo.manager / Demo-Manager-2026!, demo.admin / Demo-Admin-2026!', 'key') : null
  ));
  if (!username) u.focus(); else p.focus();
}

export function renderMfa(view, mode, onDone) {
  clear(view);
  const err = h('div');
  const code = h('input', { class: 'otp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, placeholder: '000000' });
  const signOut = h('button', { class: 'btn link', text: 'Sign out', on: { click: async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); location.hash = ''; location.reload(); } } });

  if (mode === 'verify') {
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Verify' });
    view.append(h('div', { class: 'login' }, brand('Two-step sign-in'),
      h('h1', { text: 'Enter your code' }),
      h('p', { class: 'lead', text: 'Open your authenticator app and type the 6-digit code for Direct Sales Portal.' }),
      err,
      h('form', { on: { submit: async e => {
        e.preventDefault(); clear(err); btn.disabled = true;
        try { await api('/api/auth/totp/verify', { method: 'POST', body: { code: code.value.trim() } }); await onDone(); }
        catch (x) { err.append(errorBox(x)); btn.disabled = false; code.select(); }
      } } }, field('6-digit code', code), btn),
      note('Tip: after signing in, add a passkey in Profile. Next time a passkey replaces both your password and this code.', 'key'),
      signOut));
    code.focus();
    return;
  }

  // Enrolment
  const box = h('div', {}, h('div', { class: 'spinner' }));
  view.append(h('div', { class: 'login' }, brand('Set up two-step sign-in'),
    h('h1', { text: 'Protect your account' }),
    h('p', { class: 'lead', text: 'Managers and administrators need a second step when they sign in with a password.' }),
    box, signOut));
  api('/api/auth/totp/setup', { method: 'POST', body: {} }).then(s => {
    const btn = h('button', { class: 'btn primary', type: 'submit', text: 'Turn on two-step sign-in' });
    clear(box).append(
      h('ol', { class: 'lead', style: 'padding-inline-start:20px;margin-bottom:14px' },
        h('li', { text: 'Install an authenticator app (for example Microsoft Authenticator or Google Authenticator).' }),
        h('li', { text: 'Add an account and choose “Enter a setup key”.' }),
        h('li', { text: 'Type this key, then enter the 6-digit code the app shows.' })),
      h('div', { class: 'secret', text: s.secret.replace(/(.{4})/g, '$1 ').trim() }),
      h('div', { class: 'btns', style: 'margin:8px 0 16px' },
        h('button', { class: 'btn ghost sm', text: 'Copy key', on: { click: () => copy(s.secret) } }),
        h('a', { class: 'btn ghost sm', href: s.uri, text: 'Open in app' })),
      err,
      h('form', { on: { submit: async e => {
        e.preventDefault(); clear(err); btn.disabled = true;
        try { await api('/api/auth/totp/enable', { method: 'POST', body: { code: code.value.trim() } }); await onDone(); }
        catch (x) { err.append(errorBox(x)); btn.disabled = false; }
      } } }, field('6-digit code from the app', code), btn));
  }).catch(x => clear(box).append(errorBox(x)));
}

/** Invitation / password reset link: #/link/<token> */
export async function renderLink(view, token) {
  clear(view);
  const wrap = h('div', { class: 'login' }, brand('Account setup'));
  view.append(wrap);
  let info;
  try { info = await api('/api/auth/link/' + encodeURIComponent(token)); }
  catch (x) { wrap.append(h('h1', { text: 'Link not valid' }), errorBox(x), h('a', { class: 'btn ghost', href: '#/', text: 'Go to sign-in', style: 'margin-top:16px' })); return; }
  const err = h('div');
  const p1 = h('input', { type: 'password', autocomplete: 'new-password', minlength: 10 });
  const p2 = h('input', { type: 'password', autocomplete: 'new-password' });
  const btn = h('button', { class: 'btn primary', type: 'submit', text: info.kind === 'invite' ? 'Activate my account' : 'Save new password' });
  wrap.append(
    h('h1', { text: info.kind === 'invite' ? `Welcome, ${info.name.split(' ')[0]}` : 'Choose a new password' }),
    h('p', { class: 'lead', text: `Your username is ${info.username}. Choose a password of at least 10 characters.` }),
    err,
    h('form', { on: { submit: async e => {
      e.preventDefault(); clear(err);
      if (p1.value !== p2.value) { err.append(errorBox(new Error('The two passwords don’t match.'))); return; }
      btn.disabled = true;
      try {
        const r = await api('/api/auth/link/' + encodeURIComponent(token), { method: 'POST', body: { password: p1.value } });
        sessionStorage.setItem('dsp-username', r.username);
        clear(wrap).append(brand('Account ready'), h('h1', { text: 'You’re all set' }),
          h('p', { class: 'lead', text: 'Sign in with your new password. After that you can add a passkey so next time you just use Face ID or your fingerprint.' }),
          h('a', { class: 'btn primary', href: '#/', text: 'Go to sign-in' }));
      } catch (x) { err.append(errorBox(x)); btn.disabled = false; }
    } } }, h('input', { type: 'text', autocomplete: 'username', value: info.username, hidden: true, readonly: true }),
      field('New password', p1, 'At least 10 characters. Avoid common passwords.'), field('Type it again', p2), btn));
  p1.focus();
}
