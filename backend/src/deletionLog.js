import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// Every deleted account, one JSON line each. It lives outside Keycloak's database on purpose:
// restoring a database backup brings deleted users back, and keycloak/replay-deletions.mjs uses this
// file to delete them again. Keep it out of the backups you restore over it.
const LOG_FILE = process.env.DELETION_LOG_FILE ?? path.resolve('logs/deletions.jsonl');
await mkdir(path.dirname(LOG_FILE), { recursive: true });

export async function logDeletion({ userId, username, deletedBy }) {
  const entry = { time: new Date().toISOString(), userId, username, deletedBy };
  await appendFile(LOG_FILE, JSON.stringify(entry) + '\n');
}
