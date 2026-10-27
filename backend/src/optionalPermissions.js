import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Optional permissions (e.g. "Product update emails"): users can turn each one on or off at any time,
// and saying no never limits what they can do in the app. Unlike the license terms, nothing is blocked.
//
// Admins add and delete them from the app. A deleted permission stays in the file with `deletedAt`,
// so the choices recorded for it still make sense, but users no longer see it and nobody counts as opted in.
const PERMISSIONS_FILE = process.env.OPTIONAL_PERMISSIONS_FILE ?? path.resolve('optional-permissions.json');
// Every choice a user made, one JSON line each. Append-only, so it is also the record of when someone
// opted in or out. Nobody is opted in until they turn a permission on themselves.
const CHOICES_FILE = process.env.PERMISSION_CHOICES_FILE ?? path.resolve('logs/permission-choices.jsonl');
await mkdir(path.dirname(CHOICES_FILE), { recursive: true });

// Read on every call, so edits to the file are live without restarting the backend.
async function allPermissions() {
  return JSON.parse(await readFile(PERMISSIONS_FILE, 'utf8'));
}

export async function listPermissions() {
  return (await allPermissions()).filter((p) => !p.deletedAt);
}

// Writes to the permissions file one at a time, so concurrent admin changes don't overwrite each other.
let writing = Promise.resolve();

function updatePermissions(change) {
  const run = writing.then(async () => {
    const permissions = await allPermissions();
    const result = change(permissions);
    // Written in place (not via rename) so the file keeps its owner on the host.
    await writeFile(PERMISSIONS_FILE, JSON.stringify(permissions, null, 2) + '\n');
    return result;
  });
  writing = run.catch(() => {});
  return run;
}

export class PermissionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function createPermission({ label, description }, createdBy) {
  return updatePermissions((permissions) => {
    // Ids are never reused, not even a deleted one's: old choices point to them.
    const base = slugify(label) || 'permission';
    let id = base;
    for (let n = 2; permissions.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const permission = { id, label, description, createdAt: new Date().toISOString(), createdBy };
    permissions.push(permission);
    return permission;
  });
}

export function deletePermission(id, deletedBy) {
  return updatePermissions((permissions) => {
    const permission = permissions.find((p) => p.id === id && !p.deletedAt);
    if (!permission) throw new PermissionError(404, `Unknown permission: ${id}`);
    Object.assign(permission, { deletedAt: new Date().toISOString(), deletedBy });
    return permission;
  });
}

// userId -> Map(permissionId -> latest choice), loaded once and kept up to date by setChoice().
const latestChoices = new Map();
const remember = (entry) => {
  if (!latestChoices.has(entry.userId)) latestChoices.set(entry.userId, new Map());
  latestChoices.get(entry.userId).set(entry.permissionId, entry);
};
try {
  for (const line of (await readFile(CHOICES_FILE, 'utf8')).split('\n').filter(Boolean)) remember(JSON.parse(line));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// The user's current choice for each active permission. `decidedAt` is null if they never chose (= off).
export async function permissionsFor(userId) {
  const choices = latestChoices.get(userId);
  return (await listPermissions()).map((p) => {
    const choice = choices?.get(p.id);
    return { ...p, granted: choice?.granted ?? false, decidedAt: choice?.time ?? null };
  });
}

export async function setChoice(user, permissionId, granted) {
  if (!(await listPermissions()).some((p) => p.id === permissionId)) {
    throw new PermissionError(404, `Unknown permission: ${permissionId}`);
  }
  const entry = { time: new Date().toISOString(), userId: user.id, username: user.username, permissionId, granted };
  await appendFile(CHOICES_FILE, JSON.stringify(entry) + '\n');
  remember(entry);
  return entry;
}

// Turns off everything a user opted in to, e.g. when they delete their account.
export async function revokeAll(user) {
  for (const choice of latestChoices.get(user.id)?.values() ?? []) {
    if (choice.granted) await setChoice(user, choice.permissionId, false).catch(() => {}); // deleted permission
  }
}

// Who is opted in to a permission right now, e.g. the recipients of product update emails.
export function grantedUsers(permissionId) {
  return [...latestChoices.values()]
    .map((choices) => choices.get(permissionId))
    .filter((choice) => choice?.granted)
    .map(({ userId, username, time }) => ({ userId, username, since: time }));
}
