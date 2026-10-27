import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Optional permissions (e.g. "Product update emails"): users can turn each one on or off at any time,
// and saying no never limits what they can do in the app. Unlike the license terms, nothing is blocked.
//
// The permissions are versioned as a whole set, like the terms. Every admin change (add, edit, enable,
// disable, delete) publishes a new version of the set, and a user's choices only count for the version they
// saw. So any change resets everyone's choices for every permission: nobody counts as opted in to anything
// until they go through the review again. Earlier versions stay in the file, so past choices still make sense.
const PERMISSIONS_FILE = process.env.OPTIONAL_PERMISSIONS_FILE ?? path.resolve('optional-permissions.json');
// Every choice a user made, one JSON line each. Append-only, so it is also the record of who agreed to
// which version and when.
const CHOICES_FILE = process.env.PERMISSION_CHOICES_FILE ?? path.resolve('logs/permission-choices.jsonl');
await mkdir(path.dirname(CHOICES_FILE), { recursive: true });

export class PermissionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Read on every call, so edits to the file are live without restarting the backend.
async function allVersions() {
  return JSON.parse(await readFile(PERMISSIONS_FILE, 'utf8'));
}

const latest = (versions) => versions.reduce((a, b) => (b.version > a.version ? b : a));

// The current set: { version, publishedAt, publishedBy, permissions: [{ id, label, description, enabled }] }.
export async function currentSet() {
  return latest(await allVersions());
}

// Publishes admin changes one at a time, so two admins can't both create the same version number.
let publishing = Promise.resolve();

// `change` gets a copy of the current permissions and edits it; the result becomes the next version.
function publish(change, publishedBy) {
  const run = publishing.then(async () => {
    const versions = await allVersions();
    const permissions = structuredClone(latest(versions).permissions);
    change(permissions, versions);
    const next = {
      version: latest(versions).version + 1,
      publishedAt: new Date().toISOString(),
      publishedBy,
      permissions,
    };
    // Written in place (not via rename) so the file keeps its owner on the host.
    await writeFile(PERMISSIONS_FILE, JSON.stringify([...versions, next], null, 2) + '\n');
    return next;
  });
  publishing = run.catch(() => {});
  return run;
}

function find(permissions, id) {
  const permission = permissions.find((p) => p.id === id);
  if (!permission) throw new PermissionError(404, `Unknown permission: ${id}`);
  return permission;
}

const slugify = (text) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function createPermission({ label, description }, by) {
  return publish((permissions, versions) => {
    // Ids are never reused, not even a deleted one's: old choices point to them.
    const used = new Set(versions.flatMap((v) => v.permissions.map((p) => p.id)));
    const base = slugify(label) || 'permission';
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    permissions.push({ id, label, description, enabled: true });
  }, by);
}

export function updatePermission(id, changes, by) {
  return publish((permissions) => {
    const permission = find(permissions, id);
    const updated = { ...permission, ...changes };
    if (updated.label === permission.label && updated.description === permission.description && updated.enabled === permission.enabled) {
      throw new PermissionError(400, 'Nothing changed');
    }
    Object.assign(permission, updated);
  }, by);
}

export function deletePermission(id, by) {
  return publish((permissions) => {
    permissions.splice(permissions.indexOf(find(permissions, id)), 1);
  }, by);
}

// userId -> Map(permissionId -> latest choice), loaded once and kept up to date by record().
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

// The user's choice for this permission in the given version, or undefined if they haven't made one.
const choiceIn = (userId, permissionId, version) => {
  const choice = latestChoices.get(userId)?.get(permissionId);
  return choice?.version === version ? choice : undefined;
};

// What the user sees: the enabled permissions of the current version, with their choice for each.
// `decided: false` means they haven't chosen in this version yet: it counts as off and the app asks them.
// `change` says how it differs from the previous version ('new', 'changed' or null), to point out to users.
export async function permissionsFor(userId) {
  const versions = await allVersions();
  const set = latest(versions);
  const previous = versions.find((v) => v.version === set.version - 1);
  const permissions = set.permissions.filter((p) => p.enabled).map(({ id, label, description }) => {
    const before = previous?.permissions.find((p) => p.id === id && p.enabled);
    const choice = choiceIn(userId, id, set.version);
    return {
      id, label, description,
      granted: choice?.granted ?? false,
      decided: Boolean(choice),
      decidedAt: choice?.time ?? null,
      change: !previous ? null : !before ? 'new' : before.label !== label || before.description !== description ? 'changed' : null,
    };
  });
  return { version: set.version, publishedAt: set.publishedAt, permissions };
}

// The client sends the version it showed, so a user never agrees to a set they didn't see.
export async function setChoice(user, permissionId, granted, version) {
  const set = await currentSet();
  if (version !== set.version) {
    throw new PermissionError(409, `The optional permissions changed: the current version is ${set.version}`);
  }
  if (!set.permissions.some((p) => p.id === permissionId && p.enabled)) {
    throw new PermissionError(404, `Unknown permission: ${permissionId}`);
  }
  return record(user, permissionId, granted, version);
}

async function record(user, permissionId, granted, version) {
  const entry = { time: new Date().toISOString(), userId: user.id, username: user.username, permissionId, version, granted };
  await appendFile(CHOICES_FILE, JSON.stringify(entry) + '\n');
  remember(entry);
  return entry;
}

// Turns off everything a user opted in to, e.g. when they delete their account.
export async function revokeAll(user) {
  for (const choice of latestChoices.get(user.id)?.values() ?? []) {
    if (choice.granted) await record(user, choice.permissionId, false, choice.version);
  }
}

// Who is opted in to a permission right now, e.g. the recipients of product update emails.
// Only choices made in the current version count, and nobody counts for a disabled permission.
export async function grantedUsers(permissionId) {
  const set = await currentSet();
  if (!set.permissions.some((p) => p.id === permissionId && p.enabled)) return [];
  return [...latestChoices.keys()]
    .map((userId) => choiceIn(userId, permissionId, set.version))
    .filter((choice) => choice?.granted)
    .map(({ userId, username, time }) => ({ userId, username, since: time }));
}
