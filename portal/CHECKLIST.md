# Delivery checklist

Legend: ✅ built and covered by tests or checked in a browser · 🔧 built, but needs configuration or a decision · ⏳ not built yet.

## A. Built and working

### Accounts and sign-in
- ✅ **Roles.** Three roles (agent, manager, administrator) are enforced on the server for every route. Managers only see the teams assigned to them; other teams' people return "not found".
- ✅ **Account creation.**
  - There is no self-registration.
  - Managers create agents in their own teams; admins create managers and admins.
  - New accounts get a single-use, expiring invitation link, and resending a link revokes the old one.
  - Password reset uses the same mechanism.
- ✅ **Passwords.** Stored as scrypt hashes, with a minimum length and a common-password check. A lockout after 10 failures and rate limits are in place.
- ✅ **Two-step sign-in (TOTP)** for managers and admins:
  - the secret is encrypted at rest;
  - codes can't be reused;
  - an admin can reset it.
- ✅ **Passkeys (WebAuthn):**
  - agents and staff can add and remove them;
  - sign-in needs Face ID, fingerprint or screen lock;
  - a staff passkey counts as two-step sign-in (this can be turned off);
  - managers can remove a lost phone's passkeys;
  - challenge replay, a wrong origin, a missing user-verification flag and counter rollback are refused.
- ✅ **Sessions.**
  - Secure cookie sessions with idle and absolute timeouts.
  - Deactivation applies on the very next request.
  - A password change signs out other devices.
- ✅ **Web protections.** CSRF tokens, Origin checks, a strict CSP with no inline scripts, and security headers.

### Agent app
- ✅ **Home:**
  - status, today's shift and work location with directions;
  - an on-duty timer;
  - large Punch In and Punch Out buttons;
  - pending location requests;
  - next off day and upcoming leave;
  - announcements with acknowledgement.
- ✅ **Punch-in:**
  1. The app explains what is collected.
  2. A fresh, high-accuracy location is taken; cached positions aren't accepted.
  3. A live front-camera selfie is taken, then previewed with a retake option.
  4. The server saves the record, and only then is success shown.

  The punch code has no file, gallery, paste or drop path (tested).
- ✅ **Punch-in safeguards:**
  - Single-use submission ids bound to the session mean retries never duplicate a record.
  - The database allows only one open session per agent.
  - A photo can't be used twice.
  - Stale or incomplete photos are rejected, and a failed upload leaves no file.
- ✅ **Low accuracy and exceptions:**
  - A low-accuracy reading becomes an explicit exception for review, instead of passing silently.
  - When the camera or location doesn't work, the agent submits a documented exception, which stays marked as an exception even after approval.
- ✅ **Punch-out.** A fresh location is required and the duty time is calculated. A missing punch-out is flagged and both sides are reminded; it is never auto-closed.
- ✅ **Schedule.** Four weeks of published shifts, off days and leave. Overnight shifts work.
- ✅ **Attendance history.** Includes the agent's own selfies and exception outcomes.
- ✅ **Leave:**
  - types configured by the organisation;
  - full or half days;
  - supporting documents, checked by their content;
  - cancelling a pending request;
  - the manager's decision comment shown to the agent.
- ✅ **Location sharing.** On duty only, and it answers any pending manager request.
- ✅ **Profile.** Passkeys, password change, and the location and photo notices.
- ✅ **Notifications** (in-app). They never contain leave types, reasons or medical details.

### Manager app
- ✅ **Today:** neutral counts (scheduled, on duty, punched out, no punch-in recorded, on leave, off, exceptions, leave to decide, open location requests, stale locations), with a team filter. There are no rankings or scores.
- ✅ **Map:**
  - Google Maps with Advanced Markers once a key is configured, otherwise a clear "not configured" message;
  - assigned work locations shown as squares;
  - stale markers dashed and in amber;
  - a list view with Open in Google Maps;
  - multi-select **Request location**;
  - locations shown only for on-duty agents.
- ✅ **Punches:**
  - photo thumbnails, and a full photo watermarked with the viewer's name and time;
  - every view written to the access log;
  - exception review, with a comment required to reject.
- ✅ **Requests:**
  - leave decisions, with a comment required to reject and the number of teammates already off;
  - medical documents open only with the explicit permission, and refused attempts are logged;
  - location request history with response times.
- ✅ **Team:**
  - add agents, invitation and reset links, deactivate or reactivate, remove passkeys;
  - a weekly schedule editor with drafts, then publish (agents are notified);
  - announcements targeted by team, with priority, pinning, expiry and acknowledgement counts;
  - work locations.

### Administration
- ✅ **People and teams:** teams; managers and admins with team assignments; the sensitive permissions `medical_documents` and `location_history`; resetting two-step sign-in.
- ✅ **Configuration:** leave types (medical flag, document required, available or not) and settings (staff two-step sign-in, passkeys, selfie age limit, accuracy limit, stale threshold, request expiry, photo retention, link validity).
- ✅ **Logs:** the audit log and the access log.

### Operations
- ✅ **Database:** SQLite with WAL and numbered migrations.
- ✅ **Scripts:** `npm run backup` (consistent snapshot) and `npm run create-admin`.
- ✅ **Background jobs:** expiring requests and challenges, flagging missing punch-outs, photo retention (only when configured), and an orphaned-file sweep.
- ✅ **Persistence:** data survives a restart (tested).

## B. Built, but needs configuration or a decision

- 🔧 **HTTPS hosting and a final domain.**
  - The camera, location and passkeys don't work without HTTPS.
  - Passkeys are tied to the domain, so choose it before go-live.
- 🔧 **`APP_ENCRYPTION_KEY`.** Required in production; keep it in a secrets manager.
- 🔧 **Google Maps.** Needs a browser key restricted to your origin and the Maps JavaScript API, a Map ID, a billing account, quotas and a budget alert.
- 🔧 **Policy values** the organisation must decide:
  - shift times;
  - leave types and rules;
  - photo retention (empty means nothing is deleted);
  - accuracy and stale thresholds;
  - who gets `medical_documents` and `location_history`.
- 🔧 **Backups.** Scheduling, encryption, off-site copies and a restore drill are for IT to set up.

## C. Not built yet

- ⏳ **Email delivery** of invitation and reset links. Links are shown to the manager to send privately; an SMTP relay would replace this.
- ⏳ **Reverse geocoding** (street addresses). Coordinates, accuracy and Open in Google Maps links are shown instead.
- ⏳ **Attendance corrections workflow.** The `corrected_*` columns exist, but there are no request or approval screens yet.
- ⏳ **Off-day swaps, holidays calendar, leave balances, CSV import and export, resource library and issue reports.**
- ⏳ **Optional live location sharing.**
- ⏳ **Arabic translation and right-to-left review.** The layout uses logical CSS properties, but there are no Arabic strings yet.
- ⏳ **Push notifications and offline punch queueing.**
- ⏳ **Antivirus scanning of uploads, SSO, multi-instance deployment, and a formal accessibility (WCAG) audit.**

## D. Required before real employees use it

This code was generated and tested, but that does **not** make it legally compliant or production-ready. Before real employees use it, the organisation should complete:

1. **Data-protection review** under Bahrain's Personal Data Protection Law (Law No. 30 of 2018), covering:
   - the lawful basis for collecting photos and location;
   - the employee notice;
   - retention periods;
   - access rights;
   - the hosting region;
   - any transfer to Google.
2. **HR and labour review** of how attendance evidence, exceptions and "no punch-in recorded" may be used, and of the leave rules.
3. **Employee communication:** publish the photo and location notice, explain passkeys, and name a contact for questions.
4. **Security review and penetration test** of the deployed system: the reverse proxy, TLS, secrets, backups and the admin process.
5. **Device testing** on the agents' actual phones (iPhone Safari and Android Chrome): camera, location prompts, passkeys, and outdoor readability.
6. **Restore drill:** back up and restore once before go-live.
