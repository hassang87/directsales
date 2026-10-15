import { config } from './config.js';
import { openDb, q } from './db/index.js';
import { createServer } from './app.js';
import { startJobs } from './jobs.js';
import { ensureFilesDir } from './lib/storage.js';
import { seedDemo } from '../scripts/seed-demo.js';

openDb();
ensureFilesDir();
if (config.isDemo && !q.get('SELECT 1 FROM users LIMIT 1')) { seedDemo(); console.log('Demo data created (fictional people only).'); }
startJobs();

const server = createServer();
server.listen(config.port, () => {
  console.log(`Direct Sales Portal (${config.mode}) listening on port ${config.port}`);
  console.log(`Open ${config.origin}`);
  if (!config.secureCookies) console.log('Note: camera, location and passkeys only work over HTTPS or on localhost.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
