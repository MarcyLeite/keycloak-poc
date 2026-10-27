import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Optional permissions (e.g. "Product update emails"): users can turn each one on or off at any time,
// and saying no never limits what they can do in the app. Unlike the license terms, nothing is blocked.
//
// Each permission has a `revision`. A user's choice only counts for the revision they saw, so whenever an
// admin adds a permission, changes its name or description, or enables it again, everyone's previous choice
// for it is void: nobody counts as opted in until they agree again. Earlier texts are kept in `history`.
// Disabled and deleted permissions are hidden from users and nobody counts as opted in to them.
// Deleted ones stay in the file with `deletedAt`, so past choices still make sense.
const PERMISSIONS_FILE = process.env.OPTIONAL_PERMISSIONS_FILE ?? path.resolve('optional-permissions.json');
// Every choice a user made, one JSON line each. Append-only, so it is also the record of when someone
// opted in or out, and of which revision they saw.
const CHOICES_FILE = process.env.PERMISSION_CHOICES_FILE ?? path.resolve('logs/permission-choices.jsonl');
await mkdir(path.dirname(CHOICES_FILE), { recursive: true });

export class PermissionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read on every call, so edits to the file are live without restarting the backend.
async function allPermissions() {
  return JSON.parse(await readFile(PERMISSIONS_FILE, 'utf8'));
}

// Everything admins manage: enabled and disabled, not deleted.
export async function listPermissions() {
  return (await allPermissions()).filter((p) => !p.deletedAt);
}

// What users see and can opt in to.
const activePermissions = async () => (await listPermissions()).filter((p) => p.enabled);

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

function findManaged(permissions, id) {
  const permission = permissions.find((p) => p.id === id && !p.deletedAt);
  if (!permission) throw new PermissionError(404, `Unknown permission: ${id}`);
  return permission;
}

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function createPermission({ label, description }, createdBy) {
  return updatePermissions((permissions) => {
    // Ids are never reused, not even a deleted one's: old choices point to them.
    const base = slugify(label) || 'permission';
    let id = base;
    for (let n = 2; permissions.some((p) => p.id === id); n++) id = `${base}-${n}`;
    const now = new Date().toISOString();
    const permission = {
      id, label, description, enabled: true, revision: 1,
      createdAt: now, createdBy, updatedAt: now, updatedBy: createdBy,
    };
    permissions.push(permission);
    return permission;
  });
}

// Changes name, description and/or enabled. A new name or description, or enabling it again, starts a new
// revision: every user is asked again. Disabling alone doesn't, since nobody sees it while it's off.
export function updatePermission(id, changes, updatedBy) {
  return updatePermissions((permissions) => {
    const permission = findManaged(permissions, id);
    const label = changes.label ?? permission.label;
    const description = changes.description ?? permission.description;
    const enabled = changes.enabled ?? permission.enabled;
    const textChanged = label !== permission.label || description !== permission.description;
    const reEnabled = enabled && !permission.enabled;
    if (!textChanged && enabled === permission.enabled) return permission;

    if (textChanged || reEnabled) {
      const { revision, label: oldLabel, description: oldDescription, updatedAt, updatedBy: oldBy } = permission;
      permission.history = [...(permission.history ?? []),
        { revision, label: oldLabel, description: oldDescription, updatedAt, updatedBy: oldBy }];
      permission.revision = revision + 1;
    }
    Object.assign(permission, { label, description, enabled, updatedAt: new Date().toISOString(), updatedBy });
    return permission;
  });
}

export function deletePermission(id, deletedBy) {
  return updatePermissions((permissions) => {
    const permission = findManaged(permissions, id);
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

// The user's choice for the permission's current revision, or undefined if they haven't made one yet.
const currentChoice = (userId, permission) => {
  const choice = latestChoices.get(userId)?.get(permission.id);
  return choice?.revision === permission.revision ? choice : undefined;
};

// The user's current choice for each permission they can see. `decided: false` means they haven't chosen
// for this revision yet (new or changed permission): it counts as off and the app asks them.
export async function permissionsFor(userId) {
  return (await activePermissions()).map(({ id, label, description, revision }) => {
    const choice = currentChoice(userId, { id, revision });
    const previous = latestChoices.get(userId)?.get(id);
    return {
      id, label, description, revision,
      granted: choice?.granted ?? false,
      decided: Boolean(choice),
      decidedAt: choice?.time ?? null,
      // They chose for an earlier revision: the permission changed since.
      changed: !choice && Boolean(previous),
    };
  });
}

// The client sends the revision it showed, so a user never agrees to a text they didn't see.
export async function setChoice(user, permissionId, granted, revision) {
  const permission = (await activePermissions()).find((p) => p.id === permissionId);
  if (!permission) throw new PermissionError(404, `Unknown permission: ${permissionId}`);
  if (revision !== permission.revision) {
    throw new PermissionError(409, `"${permission.label}" changed: the current revision is ${permission.revision}`);
  }
  return record(user, permissionId, granted, revision);
}

async function record(user, permissionId, granted, revision) {
  const entry = { time: new Date().toISOString(), userId: user.id, username: user.username, permissionId, revision, granted };
  await appendFile(CHOICES_FILE, JSON.stringify(entry) + '\n');
  remember(entry);
  return entry;
}

// Turns off everything a user opted in to, e.g. when they delete their account.
export async function revokeAll(user) {
  for (const choice of latestChoices.get(user.id)?.values() ?? []) {
    if (choice.granted) await record(user, choice.permissionId, false, choice.revision);
  }
}

// Who is opted in to a permission right now, e.g. the recipients of product update emails.
// Only choices for the current revision count, and nobody counts for a disabled permission.
export async function grantedUsers(permissionId) {
  const permission = (await activePermissions()).find((p) => p.id === permissionId);
  if (!permission) return [];
  return [...latestChoices.keys()]
    .map((userId) => currentChoice(userId, permission))
    .filter((choice) => choice?.granted)
    .map(({ userId, username, time }) => ({ userId, username, since: time }));
}
