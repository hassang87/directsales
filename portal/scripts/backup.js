// Usage: npm run backup [-- <directory>]
// Writes a consistent online snapshot of the database. Back up DATA_DIR/private-files separately.
import path from 'node:path';
import fs from 'node:fs';
import { openDb, rawDb, closeDb } from '../src/db/index.js';
import { config } from '../src/config.js';

const dir = path.resolve(process.argv[2] || path.join(config.dataDir, 'backups'));
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = path.join(dir, `portal-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
openDb();
rawDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
fs.chmodSync(file, 0o600);
closeDb();
console.log(`Database snapshot written to ${file}`);
console.log(`Also back up ${config.filesDir} (selfies and documents) from the same point in time.`);
