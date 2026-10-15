// Usage: npm run create-admin -- <username> <email> "<Full Name>"
// Prints a single-use activation link. The admin sets a password, then must set up two-step sign-in (or a passkey).
import { openDb, q, closeDb } from '../src/db/index.js';
import { issueLink } from '../src/routes/auth.js';
import { audit } from '../src/lib/services.js';

const [username, email, ...nameParts] = process.argv.slice(2);
const name = nameParts.join(' ');
if (!username || !email || !name) {
  console.error('Usage: npm run create-admin -- <username> <email> "<Full Name>"');
  process.exit(1);
}
openDb();
if (q.get('SELECT 1 FROM users WHERE username = ?', username.toLowerCase())) { console.error('That username already exists.'); process.exit(1); }
const id = Number(q.run(`INSERT INTO users(role, username, name, email, status, created_at) VALUES ('admin', ?, ?, ?, 'invited', ?)`, username.toLowerCase(), name, email, Date.now()).lastInsertRowid);
const link = issueLink(id, 'invite');
audit(null, 'admin_created_cli', id);
console.log(`Administrator "${username}" created.`);
console.log(`Activation link (single use, expires ${new Date(link.expiresAt).toISOString()}):`);
console.log(link.url);
closeDb();
