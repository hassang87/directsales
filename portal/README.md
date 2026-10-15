# Direct Sales Portal (Bahrain)

A mobile-first web portal for an outdoor sales team in Bahrain. Agents and their managers both sign in to it.

**Agents** can:
- punch in with a live camera selfie and a fresh location, and punch out with a fresh location;
- submit an exception when the camera or location doesn't work;
- see their published schedule, off days and approved leave;
- request leave, with a supporting document where needed;
- share their location when on duty;
- read and acknowledge announcements;
- sign in with a **passkey** (Face ID, fingerprint or screen lock) or a password.

**Managers** can:
- see today's factual counts;
- see a map of on-duty agents' latest recorded locations, and request a fresh one;
- open punch-in photos (every view is logged);
- review exceptions and decide leave;
- build and publish schedules;
- post announcements;
- add agents, send invitation and reset links, deactivate accounts and remove lost passkeys.

**Administrators** also manage:
- teams, managers and sensitive permissions;
- leave types and settings;
- the audit log and access log.

> **Status:** working software with 16 automated acceptance tests. It is **not** certified as production-ready or legally compliant. See [CHECKLIST.md](CHECKLIST.md) for what is built, what needs configuration, and the reviews required before real employees use it.

---

## Run it

You need **Node.js 22.13 or newer** (22.22 and 24 are tested). There is no `npm install` step, because the project has no dependencies.

### Demo mode (fictional data)

```bash
npm run dev            # http://localhost:3000
```

Demo mode creates two teams, fictional agents, two weeks of published schedules, and two **synthetic** on-duty sessions, which are labelled as synthetic everywhere. It also turns off two-step sign-in for staff. **Demo sign-ins are not secure.**

| Role | Username | Password (demo only) |
|---|---|---|
| Administrator | `demo.admin` | `Demo-Admin-2026!` |
| Manager, Team North | `demo.manager` | `Demo-Manager-2026!` |
| Manager, Team South | `demo.manager2` | `Demo-Manager-2026!` |
| Agents | `agent.noor`, `agent.faisal`, `agent.mariam` (North); `agent.yusuf`, `agent.sara` (South) | `Demo-Agent-2026!` |

`agent.hamad` is not activated yet. Sign in as `demo.manager`, open **Team**, pick Hamad and choose **Resend invitation link** to try the activation flow.

Camera, location and passkeys work on `localhost`. On any other address they need **HTTPS**.

### Tests

```bash
npm test
```

The tests run a real HTTP server with a fresh database. Passkeys are tested with a built-in software authenticator. They cover:
- **Sign-in and accounts:**
  - CSRF and origin checks;
  - staff two-step sign-in, including refusing a reused code;
  - invitation and reset links: single use, expiry, revoked on resend;
  - immediate deactivation;
  - rate limits and lockout;
  - role and team scoping.
- **Passkeys:**
  - registration and sign-in;
  - refusal on challenge replay, a wrong origin (phishing) or a missing user-verification flag;
  - removal;
  - a manager's passkey counting as two-step sign-in.
- **Punch-in and punch-out:**
  - a location is required;
  - incomplete, non-JPEG and stale photos are rejected, and no orphaned files are left;
  - retries and replays never duplicate a record;
  - the database allows only one open session;
  - a photo can't be used twice;
  - punch-out rules;
  - no file, gallery, paste or drop path in the punch code.
- **Exceptions and photos:**
  - exceptions stay exceptions even after approval;
  - punch photos are visible only to the agent and same-team managers, and every view, including refused ones, is logged.
- **Leave:**
  - document content checks, including rejecting PDFs that carry scripts;
  - medical documents need the explicit permission, and refusals are logged;
  - notifications don't reveal the leave type;
  - approval shows on the agent's calendar.
- **Location requests:** only on-duty agents can be asked; off-duty agents expose no location.
- **Schedules:** drafts stay hidden until published; one team can't edit another's.
- **Persistence** across a database restart.

---

## Production setup

```bash
cp .env.example .env        # set APP_MODE=production, APP_ORIGIN, APP_ENCRYPTION_KEY
npm run migrate
npm run create-admin -- jsmith j.smith@company.bh "Jane Smith"
#   prints a single-use activation link (72 h); the admin sets a password,
#   then sets up two-step sign-in (or signs in with a passkey after adding one)
npm start
```

**As the administrator:**
1. Create teams.
2. Add managers and assign their teams.
3. Grant `medical_documents` and `location_history` only to the people your policy names.
4. Review **Settings**.

**As each manager:**
1. Add work locations.
2. Add agents. Each agent gets an invitation link to send privately.
3. Build the week in **Team → Schedule**, then **Publish**.

### Deployment
- **Server.** Use a Linux VM or container with Node 22.13+, in a hosting region your data-protection review approves.
- **HTTPS reverse proxy.** Put nginx or Caddy in front with TLS, and set `TRUST_PROXY=true`. **HTTPS is mandatory**: phones block the camera, location and passkeys on plain HTTP.
- **Service.** Run `npm start` under systemd with `Restart=always`, as an unprivileged user. Make `DATA_DIR` readable only by that user.
- **Backups.** `npm run backup` writes a consistent database snapshot. Also back up `DATA_DIR/private-files/`, which holds the selfies and documents. Encrypt backups, test restores, and apply the same retention to backup copies.
- **Scaling.** The design assumes one process; the in-memory rate limiter and background jobs depend on it. For more than one instance, move to PostgreSQL, use Redis for rate limits, and keep files in private object storage.

---

## Passkeys

Passkeys use WebAuthn, implemented with Node's built-in `crypto` and a small CBOR decoder. There are no third-party libraries.

**How agents use them:**
- **Sign-in screen.** The main button is **Sign in with a passkey**. Username and password stay available as a fallback.
- **Adding one.** After a password sign-in on a phone that supports passkeys, the app offers to save one once. Agents can also add or remove passkeys under **Profile → Passkeys**.
- **Lost phone.** A manager opens the agent under **Team** and chooses **Remove passkeys**. The agent signs in with their password, or a reset link, and adds a new passkey.

**How it works on the server:**
- **What is requested.** Discoverable credentials and `userVerification: required`. `attestation: none`, so no device make or model is collected.
- **Algorithms.** ES256, EdDSA and RS256 (2048-bit or larger).
- **Challenges.** Single-use and expire after 5 minutes. A sign-in challenge is bound to a short-lived cookie; a registration challenge is bound to the session.
- **Checks on every sign-in.**
  - The origin and the `rpId` hash must match.
  - User presence and user verification are required.
  - A signature counter that goes backwards is refused. Synced passkeys report 0 and are allowed.
- **Staff two-step sign-in.** A user-verified passkey counts as two-step sign-in for managers and admins. Admins can turn this off in **Settings**.

**Important: choose the final domain before go-live.** Passkeys are tied to `APP_ORIGIN`'s hostname, so changing the domain later invalidates every passkey.

**Phones.** iOS 16+ and Android 9+ with Google Play Services support passkeys. Passkeys suit personal phones: anyone who can unlock a shared phone can use the passkeys saved on it.

---

## Google Maps (optional)

Without a key, the manager map shows **Map not configured**. The list of on-duty agents still works, with **Open in Google Maps** links.

To turn the map on:
1. In Google Cloud, create a project and link a billing account.
2. Enable **Maps JavaScript API** only.
3. Create a **browser key**:
   - Application restriction: **Websites**, with your exact origin, e.g. `https://portal.example.bh/*`.
   - API restriction: **Maps JavaScript API**.
4. Create a **Map ID** under *Map management*. Advanced Markers need it.
5. Set `GOOGLE_MAPS_BROWSER_KEY` and `GOOGLE_MAPS_MAP_ID` in `.env`.
6. Set quotas and a budget alert.

Check the current pricing on Google's page before go-live.

Reverse geocoding (readable street addresses) is **not built**. The portal shows coordinates, accuracy and an "Open in Google Maps" link instead.

---

## Security notes

- **Passwords.** Stored as scrypt hashes (N=32768). Minimum 10 characters, with a common-password check. Accounts lock for 15 minutes after 10 failed attempts.
- **Sessions.**
  - A random token in an HttpOnly, SameSite=Lax cookie (Secure over HTTPS); only its SHA-256 is stored.
  - Sessions expire after 12 hours idle or 14 days in total.
  - Every request re-checks the account, so deactivation is immediate.
  - Changing or resetting a password signs out other devices.
- **CSRF.** Every state change needs a per-session token and an Origin header that matches `APP_ORIGIN`.
- **Two-step sign-in.** TOTP secrets are encrypted at rest with AES-256-GCM (`APP_ENCRYPTION_KEY`). A code can't be reused.
- **Headers.**
  - A strict Content-Security-Policy: no inline scripts, and only Google Maps origins allowed.
  - `X-Frame-Options: DENY` and `nosniff`.
  - `Permissions-Policy` limits camera, location and passkeys to this site.
  - HSTS is sent over HTTPS.
- **Uploads.**
  - The type is decided from the file's bytes, never its name.
  - Selfies must be complete JPEGs captured within the configured time.
  - Documents may be PDF, JPG or PNG. PDFs with JavaScript, launch actions or embedded files are rejected.
  - Files are stored outside the web root with random names and `0600` permissions.
  - Failed uploads are deleted at once, and a background sweep every 15 minutes removes orphaned files older than an hour.
- **Logs.**
  - The audit log records account, permission, schedule, leave, exception, location-request and settings changes.
  - The access log records every view of a punch photo, medical document or location history, including refused attempts.
- **Privacy defaults.**
  - Locations are recorded only at punch in/out or when the agent shares, never in the background.
  - Managers see a location only while the agent is on duty.
  - No face recognition or biometric templates are used. The selfie is supporting evidence only.
  - Notifications never contain leave types, reasons or medical details.

## Project structure

```
src/
  server.js            start-up (demo seed, background jobs)
  app.js               request pipeline: session, origin + CSRF checks, roles, MFA gate, JSON
  config.js            .env and defaults
  jobs.js              request expiry, missing punch-out flags, photo retention, orphan sweep
  db/                  SQLite (node:sqlite) + numbered migrations
  lib/                 http, security (scrypt, TOTP, AES-GCM), webauthn + cbor, storage, access, time, validation
  routes/              auth, passkeys, agent, team (manager), admin
public/                the web app (plain ES modules, no build step)
scripts/               migrate, create-admin, backup, seed-demo
test/                  acceptance tests (node:test)
```
