#!/usr/bin/env node
// Deletes again every account listed in the deletion log. Run it after restoring a Keycloak backup,
// before letting users back in: the backup may contain users who deleted their account after it was taken.
// Idempotent: users that are already gone are skipped.
//
//   node keycloak/replay-deletions.mjs [path/to/deletions.jsonl]
//
// Env: KEYCLOAK_URL (default http://localhost/auth), KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD (default admin/admin)

import { readFile } from 'node:fs/promises';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost/auth';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const REALM = 'poc';
const LOG_FILE = process.argv[2] ?? new URL('../backend/logs/deletions.jsonl', import.meta.url);

async function login() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Admin login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

let text;
try {
  text = await readFile(LOG_FILE, 'utf8');
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
  console.log('No deletion log found: nothing to replay.');
  process.exit(0);
}
const entries = text.split('\n').filter(Boolean).map((line) => JSON.parse(line));

const token = await login();
let deleted = 0;
for (const { userId, username } of entries) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}/users/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.ok) {
    deleted++;
    console.log(`deleted  ${username} (${userId})`);
  } else if (res.status === 404) {
    console.log(`gone     ${username} (${userId})`);
  } else {
    throw new Error(`DELETE ${username} (${userId}) -> ${res.status} ${await res.text()}`);
  }
}
console.log(`\nDone. ${entries.length} logged deletions, ${deleted} restored users deleted again.`);
