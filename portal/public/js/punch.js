// Punch-in with a live camera selfie and a fresh location. There is deliberately no file input, gallery,
// paste or drop path in this module: the only image source is the live getUserMedia stream.
import { api, h, clear, icon, note, errorBox, tm, dur, openSheet, closeSheet, onSheetClose, toast, gmaps } from './core.js';

const EXC_REASONS = ['Camera not working', 'Location unavailable', 'Permission denied on my phone', 'No mobile data', 'Other'];

/** One fresh, high-accuracy reading. Cached positions are not allowed. */
export function freshLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can’t provide your location.'));
    if (!window.isSecureContext) return reject(new Error('Location needs the portal’s secure (HTTPS) address.'));
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      e => reject(new Error(e.code === 1 ? 'Location permission is turned off for this site. Allow it in your browser settings, then try again.' : e.code === 3 ? 'Getting a location took too long. Step outside or near a window and try again.' : 'Your location is not available right now.')),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  });
}

function locatingScreen(s, steps, step) {
  s.setSteps(step, steps);
  s.render([h('div', { class: 'radar' }, h('div', { class: 'core' }, icon('pin', 30))),
    h('div', { class: 'center' }, h('h1', { text: 'Getting a fresh location…' }), h('p', { class: 'lead', text: 'For best accuracy, step outside or near a window. If your phone asks, tap Allow.' }))]);
}
function locationCard(loc, maxAcc) {
  const good = loc.acc <= maxAcc;
  return [
    h('div', { class: 'kv', style: 'margin-top:14px' },
      h('div', {}, h('span', { text: 'Coordinates' }), h('b', { text: `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` })),
      h('div', {}, h('span', { text: 'Accuracy' }), h('b', {}, h('span', { class: `pill ${good ? 'green' : 'amber'}` }, h('i'), `± ${loc.acc} m`))),
      h('div', {}, h('span', { text: 'Check on a map' }), h('b', {}, h('a', { href: gmaps(loc.lat, loc.lng), target: '_blank', rel: 'noopener', text: 'Open in Google Maps' })))),
    good ? null : note(`Low accuracy (more than ${maxAcc} m). You can continue, but your manager will be asked to review this reading.`, 'alert', 'warn')
  ];
}

/* ---------------- punch in ---------------- */
export function openPunchIn(onDone) {
  const s = openSheet('Punch in', { steps: 5, step: 0 });
  let sub = null, loc = null, photo = null, capturedAt = 0, stream = null;
  const stopCam = () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } };
  onSheetClose(stopCam);

  function notice() {
    s.setSteps(0, 5);
    s.render([
      h('h1', { text: 'Ready to start?' }), h('p', { class: 'lead', text: 'Here is exactly what punching in collects, and why.' }),
      h('div', { style: 'margin-top:8px' },
        h('div', { class: 'bul' }, h('div', { class: 'ico' }, icon('camera')), h('div', {}, h('b', { text: 'A live selfie' }), h('span', { text: 'Taken now with your front camera. Gallery photos can’t be used. It is supporting evidence only; no face recognition is done.' }))),
        h('div', { class: 'bul' }, h('div', { class: 'ico' }, icon('pin')), h('div', {}, h('b', { text: 'One fresh location' }), h('span', { text: 'A single reading right now. No background or off-duty tracking.' }))),
        h('div', { class: 'bul' }, h('div', { class: 'ico' }, icon('clock')), h('div', {}, h('b', { text: 'Official server time' }), h('span', { text: 'The time is recorded by the server, in Bahrain time.' })))),
      note('Only you and your team’s authorised managers can see your photo, and every view is logged.')
    ], [h('button', { class: 'btn primary', text: 'Allow and continue', on: { click: start } })]);
  }
  async function start() {
    try { sub = await api('/api/punch/start', { method: 'POST', body: {} }); }
    catch (x) { if (x.code === 'already_on_duty') { closeSheet(); toast('You are already punched in.'); onDone(); return; } s.render([errorBox(x)], [h('button', { class: 'btn ghost', text: 'Close', on: { click: closeSheet } })]); return; }
    locate();
  }
  async function locate() {
    locatingScreen(s, 5, 1);
    try { loc = await freshLocation(); located(); }
    catch (x) { failScreen('Location unavailable', x.message + ' A fresh location is required for a standard punch-in.', locate); }
  }
  function located() {
    s.setSteps(1, 5);
    s.render([h('h1', { text: 'Location captured' }), h('p', { class: 'lead', text: 'This reading will be saved with your punch.' }), locationCard(loc, sub.maxAccuracy)],
      [h('button', { class: 'btn primary', on: { click: camera } }, icon('camera'), 'Next: take selfie'),
       h('button', { class: 'btn link', on: { click: locate } }, icon('refresh', 16), 'Take a new reading')]);
  }
  async function camera() {
    s.setSteps(2, 5);
    const video = h('video', { playsinline: true, muted: true, autoplay: true });
    video.muted = true;
    const shutter = h('button', { class: 'shutter', 'aria-label': 'Take selfie', disabled: true, on: { click: capture } });
    s.render([h('div', { class: 'camwrap' }, video, h('div', { class: 'oval' })), h('p', { class: 'center muted sm', style: 'margin-top:12px', text: 'Fit your face in the oval and look at the camera.' })],
      [shutter, h('p', { class: 'center muted sm', text: 'Tap to capture' })]);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'NotSupported' });
      stopCam();
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 720 }, height: { ideal: 960 } }, audio: false });
      video.srcObject = stream; await video.play().catch(() => {});
      shutter.disabled = false;
    } catch (e) {
      stopCam();
      failScreen('Camera unavailable', e.name === 'NotAllowedError' ? 'Camera permission is turned off for this site. Allow it in your browser settings, then try again.' : 'No front camera is available.', camera);
    }
    function capture() {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) { toast('Camera is still starting…'); return; }
      const c = document.createElement('canvas'); c.width = 480; c.height = 640;
      const x = c.getContext('2d');
      let sw, sh, sx, sy; if (vw / vh > .75) { sh = vh; sw = vh * .75; sx = (vw - sw) / 2; sy = 0; } else { sw = vw; sh = vw / .75; sx = 0; sy = (vh - sh) / 2; }
      x.translate(480, 0); x.scale(-1, 1); x.drawImage(video, sx, sy, sw, sh, 0, 0, 480, 640);
      photo = c.toDataURL('image/jpeg', 0.85); capturedAt = Date.now();
      stopCam(); preview();
    }
  }
  function preview() {
    s.setSteps(3, 5);
    s.render([h('h1', { text: 'Looks good?' }), h('p', { class: 'lead', text: 'Make sure your face is clear and well lit.' }), h('div', { class: 'camwrap', style: 'margin-top:14px' }, h('img', { src: photo, alt: 'Your selfie' }))],
      [h('button', { class: 'btn primary', on: { click: save } }, icon('check'), 'Use photo and punch in'),
       h('button', { class: 'btn ghost', on: { click: camera } }, icon('refresh', 18), 'Retake')]);
  }
  async function save() {
    s.render([h('div', { class: 'spinner' }), h('p', { class: 'center lead', text: 'Uploading your photo and saving your punch…' })]);
    try {
      const r = await api('/api/punch/in', { method: 'POST', body: { submissionId: sub.submissionId, ...loc, capturedAt, photo } });
      done(r.attendance);
    } catch (x) {
      if (x.code === 'photo_stale') { failScreen('Selfie too old', x.message, camera, false); return; }
      // Retrying with the same submission id is safe: the server never saves it twice.
      s.render([h('div', { class: 'errbig' }, icon('alert', 38)), h('h1', { class: 'center', text: 'Not saved yet' }), errorBox(x), note('You are not punched in until you see the green confirmation.', 'alert', 'warn')],
        [h('button', { class: 'btn primary', text: 'Try again', on: { click: save } }), h('button', { class: 'btn ghost', text: 'Retake selfie', on: { click: camera } })]);
    }
  }
  function done(a) {
    s.setSteps(4, 5);
    const exc = a.kind === 'exception';
    s.render([
      h('div', { class: `ok ${exc ? 'amber' : ''}` }, icon(exc ? 'alert' : 'check', 46)),
      h('div', { class: 'center' }, h('h1', { text: exc ? 'Punched in, review needed' : 'You’re punched in' }),
        h('p', { class: 'lead', text: exc ? a.excReason + '. Your manager will review it.' : 'Saved by the server. Have a great shift!' })),
      h('div', { class: 'kv', style: 'margin-top:18px' },
        h('div', {}, h('span', { text: 'Time (Bahrain)' }), h('b', { text: tm(a.punchInAt) })),
        h('div', {}, h('span', { text: 'Accuracy' }), h('b', { text: `± ${a.in.acc} m` })),
        h('div', {}, h('span', { text: 'Selfie' }), h('b', { text: 'Saved privately' })))
    ], [h('button', { class: 'btn dark', text: 'Done', on: { click: () => { closeSheet(); onDone(); } } })]);
  }
  function failScreen(title, msg, retry, allowException = true) {
    s.render([h('div', { class: 'errbig' }, icon('alert', 38)), h('div', { class: 'center' }, h('h1', { text: title }), h('p', { class: 'lead', text: msg }))],
      [h('button', { class: 'btn primary', text: 'Try again', on: { click: retry } }),
       allowException ? h('button', { class: 'btn link', text: 'Report a problem and submit an exception', on: { click: exception } }) : null]);
  }
  function exception() {
    s.setSteps(1, 5);
    const why = h('select', {}, EXC_REASONS.map(r => h('option', { text: r })));
    const det = h('textarea', { rows: 4, maxlength: 500, placeholder: 'For example: the camera shows a black screen' });
    const err = h('div');
    const btn = h('button', { class: 'btn primary', text: 'Submit exception', on: { click: async () => {
      clear(err); btn.disabled = true;
      try {
        const r = await api('/api/punch/exception', { method: 'POST', body: { submissionId: sub.submissionId, reason: why.value, note: det.value, ...(loc || {}) } });
        s.render([h('div', { class: 'ok amber' }, icon('alert', 46)), h('div', { class: 'center' }, h('h1', { text: 'Exception submitted' }),
          h('p', { class: 'lead', text: `You are on duty from ${tm(r.attendance.punchInAt)}. Your manager will review this exception.` }))],
          [h('button', { class: 'btn dark', text: 'Done', on: { click: () => { closeSheet(); onDone(); } } })]);
      } catch (x) { err.append(errorBox(x)); btn.disabled = false; }
    } } });
    s.render([h('h1', { text: 'Submit an exception' }), h('p', { class: 'lead', text: 'Use this only when the camera or location doesn’t work. Exceptions are reviewed by your manager and always shown separately from standard punches.' }),
      h('div', { style: 'margin-top:16px' }, h('div', { class: 'field' }, h('label', { text: 'What happened?' }), why), h('div', { class: 'field' }, h('label', { text: 'Details' }), det)),
      loc ? note(`Your location reading (± ${loc.acc} m) will be included.`, 'pin') : note('No location will be included.', 'pin'), err], [btn]);
  }
  notice();
}

/* ---------------- punch out ---------------- */
export function openPunchOut(open, onDone) {
  const s = openSheet('Punch out', { steps: 3, step: 0 });
  let loc;
  const notice = () => {
    s.setSteps(0, 3);
    s.render([h('h1', { text: 'Finish your shift' }), h('p', { class: 'lead', text: 'We’ll take one fresh location reading, then close your session.' }),
      h('div', { class: 'kv', style: 'margin-top:18px' },
        h('div', {}, h('span', { text: 'Punched in' }), h('b', { text: tm(open.punchInAt) })),
        h('div', {}, h('span', { text: 'On duty so far' }), h('b', { text: dur(Date.now() - open.punchInAt) })))],
      [h('button', { class: 'btn dark', on: { click: locate } }, icon('pin'), 'Get my location')]);
  };
  async function locate() {
    locatingScreen(s, 3, 1);
    try { loc = await freshLocation(); }
    catch (x) {
      s.render([h('div', { class: 'errbig' }, icon('alert', 38)), h('div', { class: 'center' }, h('h1', { text: 'Location unavailable' }), h('p', { class: 'lead', text: x.message })),
        note('If you can’t get a location, you stay punched in. Ask for a correction from Attendance so your manager can record the right time.', 'alert', 'warn')],
        [h('button', { class: 'btn primary', text: 'Try again', on: { click: locate } })]);
      return;
    }
    s.setSteps(1, 3);
    s.render([h('h1', { text: 'Location captured' }), locationCard(loc, 100000)],
      [h('button', { class: 'btn dark', on: { click: save } }, icon('logout'), 'Confirm punch out'), h('button', { class: 'btn link', on: { click: locate } }, icon('refresh', 16), 'Take a new reading')]);
  }
  async function save() {
    s.render([h('div', { class: 'spinner' })]);
    try {
      const r = await api('/api/punch/out', { method: 'POST', body: loc });
      const a = r.attendance;
      s.setSteps(2, 3);
      s.render([h('div', { class: 'ok' }, icon('check', 46)), h('div', { class: 'center' }, h('h1', { text: 'You’re punched out' }), h('p', { class: 'lead', text: 'Thanks for today. Your session is closed.' })),
        h('div', { class: 'kv', style: 'margin-top:18px' },
          h('div', {}, h('span', { text: 'Punched in' }), h('b', { text: tm(a.punchInAt) })),
          h('div', {}, h('span', { text: 'Punched out' }), h('b', { text: tm(a.punchOutAt) })),
          h('div', {}, h('span', { text: 'Duty recorded' }), h('b', { text: dur(a.punchOutAt - a.punchInAt) })))],
        [h('button', { class: 'btn dark', text: 'Done', on: { click: () => { closeSheet(); onDone(); } } })]);
    } catch (x) { s.render([errorBox(x)], [h('button', { class: 'btn primary', text: 'Try again', on: { click: save } })]); }
  }
  notice();
}

/* ---------------- share location ---------------- */
export function openShare(request, onDone) {
  const s = openSheet('Share location', { steps: 2, step: 0 });
  let loc;
  async function locate() {
    locatingScreen(s, 2, 0);
    try { loc = await freshLocation(); }
    catch (x) { s.render([h('div', { class: 'errbig' }, icon('alert', 38)), h('div', { class: 'center' }, h('h1', { text: 'Location unavailable' }), h('p', { class: 'lead', text: x.message }))], [h('button', { class: 'btn primary', text: 'Try again', on: { click: locate } })]); return; }
    s.render([h('h1', { text: 'Send this location?' }), request ? h('p', { class: 'lead', text: `${request.manager} asked: ${request.reason}` }) : h('p', { class: 'lead', text: 'Your manager will see this reading.' }), locationCard(loc, 100000)],
      [h('button', { class: 'btn primary', on: { click: send } }, icon('send'), 'Send location'), h('button', { class: 'btn link', on: { click: locate } }, icon('refresh', 16), 'Take a new reading')]);
  }
  async function send() {
    s.render([h('div', { class: 'spinner' })]);
    try {
      await api('/api/location/share', { method: 'POST', body: loc });
      s.setSteps(1, 2);
      s.render([h('div', { class: 'ok' }, icon('check', 46)), h('div', { class: 'center' }, h('h1', { text: 'Location sent' }), h('p', { class: 'lead', text: `Sent at ${tm(Date.now())} (± ${loc.acc} m).` }))],
        [h('button', { class: 'btn dark', text: 'Done', on: { click: () => { closeSheet(); onDone(); } } })]);
    } catch (x) { s.render([errorBox(x)], [h('button', { class: 'btn primary', text: 'Try again', on: { click: send } })]); }
  }
  locate();
}
