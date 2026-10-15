import { openDb, closeDb } from '../src/db/index.js';
import { config } from '../src/config.js';

openDb();
console.log(`Database is up to date: ${config.dbFile}`);
closeDb();
