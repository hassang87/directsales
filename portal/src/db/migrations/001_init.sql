-- Direct Sales Portal schema. All timestamps are UTC milliseconds since epoch.
-- Dates that belong to the business calendar (shift dates, leave dates) are 'YYYY-MM-DD' in Asia/Bahrain.

-- A team of agents. Managers are scoped to one or more teams.
CREATE TABLE teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- Every person who can sign in. No self-registration: accounts are created by managers/admins.
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('agent','manager','admin')),
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT,
  employee_id TEXT,
  mobile TEXT,
  team_id INTEGER REFERENCES teams(id),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','deactivated')),
  password_hash TEXT,
  totp_secret_enc TEXT,          -- AES-GCM sealed base32 secret; NULL until enrolled
  totp_last_step INTEGER NOT NULL DEFAULT 0,  -- blocks code reuse
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Which teams a manager may see and act on.
CREATE TABLE manager_teams (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, team_id)
);

-- Explicit sensitive permissions (granted even to admins explicitly): medical_documents, location_history.
CREATE TABLE permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  PRIMARY KEY (user_id, perm)
);

-- Sign-in sessions. Only a SHA-256 of the cookie token is stored.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  mfa_ok INTEGER NOT NULL DEFAULT 0,
  via TEXT NOT NULL DEFAULT 'password',   -- password | passkey
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- Single-use, expiring invitation and password-reset links. Only a hash is stored.
CREATE TABLE tokens (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER
);

-- Passkeys (WebAuthn). Public keys only; private keys never leave the user's device.
CREATE TABLE webauthn_credentials (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE,   -- base64url
  public_key_jwk TEXT NOT NULL,
  alg INTEGER NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  device_label TEXT NOT NULL,
  backup_eligible INTEGER NOT NULL DEFAULT 0,
  backed_up INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

-- Single-use WebAuthn challenges (5 minutes).
CREATE TABLE webauthn_challenges (
  challenge TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('register','login')),
  user_id INTEGER,
  binding TEXT NOT NULL,                -- session id (register) or pre-auth cookie hash (login)
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Assigned work locations, chosen by managers. Separate from captured GPS readings.
CREATE TABLE work_locations (
  id INTEGER PRIMARY KEY,
  team_id INTEGER NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

-- One schedule entry per agent per day. Agents only see published entries.
CREATE TABLE shifts (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shift','off')),
  start_time TEXT,
  end_time TEXT,
  work_location_id INTEGER REFERENCES work_locations(id),
  published INTEGER NOT NULL DEFAULT 0,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, date)
);

-- Attendance sessions. Original times are never overwritten; corrections would go in corrected_* columns.
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('standard','exception')),
  punch_in_at INTEGER NOT NULL,
  in_lat REAL, in_lng REAL, in_acc REAL,
  photo_file TEXT,
  photo_sha256 TEXT UNIQUE,             -- a photo can only be used once
  punch_out_at INTEGER,
  out_lat REAL, out_lng REAL, out_acc REAL,
  corrected_in_at INTEGER,
  corrected_out_at INTEGER,
  exc_reason TEXT,
  exc_note TEXT,
  exc_status TEXT CHECK (exc_status IN ('pending','approved','rejected')),
  exc_decided_by INTEGER,
  exc_comment TEXT,
  synthetic INTEGER NOT NULL DEFAULT 0,  -- demo-mode records, labelled everywhere
  created_at INTEGER NOT NULL
);
-- Only one open attendance session per agent, enforced by the database.
CREATE UNIQUE INDEX one_open_session ON attendance(user_id) WHERE punch_out_at IS NULL;

-- Single-use punch submission ids, bound to the sign-in session. Make retries safe.
CREATE TABLE punch_submissions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  attendance_id INTEGER
);

-- Every recorded location reading. Recorded only at punch in/out or when the agent shares.
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  lat REAL NOT NULL, lng REAL NOT NULL, acc REAL NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('punch_in','punch_out','share','request')),
  request_id INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX locations_user_at ON locations(user_id, at);

-- A manager asking an on-duty agent for a fresh location.
CREATE TABLE location_requests (
  id INTEGER PRIMARY KEY,
  manager_id INTEGER NOT NULL REFERENCES users(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','answered','expired','cancelled')),
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);

-- Leave types are configured by the organisation; no entitlements are assumed.
CREATE TABLE leave_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  medical INTEGER NOT NULL DEFAULT 0,
  requires_document INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type_id INTEGER NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  portion TEXT NOT NULL DEFAULT 'full' CHECK (portion IN ('full','morning','afternoon')),
  comment TEXT,
  doc_file TEXT,
  doc_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER,
  decision_comment TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

CREATE TABLE announcements (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high')),
  pinned INTEGER NOT NULL DEFAULT 0,
  team_id INTEGER REFERENCES teams(id),  -- NULL = everyone (admins only)
  requires_ack INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

CREATE TABLE announcement_acks (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);

-- In-app notifications. Text never contains leave types, reasons or medical details.
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  link TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);

-- Who changed what.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  at INTEGER NOT NULL
);

-- Who looked at sensitive data (photos, medical documents, location history), including denied attempts.
CREATE TABLE access_log (
  id INTEGER PRIMARY KEY,
  actor_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  subject_user_id INTEGER,
  ref TEXT,
  allowed INTEGER NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
