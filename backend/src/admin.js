import { Router } from 'express';
import { TIER_GROUPS, createUser, listUsers, setUserGroup } from './keycloakAdmin.js';
import { acceptanceOf, listTerms, publishTerms } from './terms.js';
import { createPermission, currentSet, deletePermission, grantedUsers, updatePermission } from './optionalPermissions.js';

// Mounted behind authenticate + requireRole('admin').
export const adminRouter = Router();

const REQUIRED_FIELDS = ['username', 'email', 'firstName', 'lastName', 'password', 'group'];

adminRouter.get('/groups', (_req, res) => res.json(TIER_GROUPS));

adminRouter.get('/users', async (_req, res) => {
  // Terms acceptance lives in our own store, not in Keycloak.
  const users = await listUsers();
  res.json(users.map((u) => ({ ...u, termsAccepted: acceptanceOf(u.id) })));
});

adminRouter.post('/users', async (req, res) => {
  const body = req.body ?? {};
  const missing = REQUIRED_FIELDS.filter((f) => typeof body[f] !== 'string' || !body[f].trim());
  if (missing.length) return res.status(400).json({ error: `Missing fields: ${missing.join(', ')}` });
  if (!TIER_GROUPS.includes(body.group)) return res.status(400).json({ error: `Unknown group: ${body.group}` });

  const user = await createUser({
    username: body.username.trim(),
    email: body.email.trim(),
    firstName: body.firstName.trim(),
    lastName: body.lastName.trim(),
    password: body.password,
    group: body.group,
  });
  console.log(`[admin] ${req.user.username} created user ${user.username} in group ${user.group}`);
  res.status(201).json(user);
});

adminRouter.put('/users/:id/group', async (req, res) => {
  const group = req.body?.group;
  if (!TIER_GROUPS.includes(group)) return res.status(400).json({ error: `Unknown group: ${group}` });
  await setUserGroup(req.params.id, group);
  console.log(`[admin] ${req.user.username} moved user ${req.params.id} to group ${group}`);
  res.json({ id: req.params.id, group });
});

adminRouter.get('/terms', async (_req, res) => {
  res.json(await listTerms());
});

// Publishes a new version. Every user, including this admin, must accept it before using the API again.
adminRouter.post('/terms', async (req, res) => {
  const { title, text } = req.body ?? {};
  if (typeof title !== 'string' || !title.trim() || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Missing fields: title and text are required' });
  }
  const entry = await publishTerms({ title: title.trim(), text }, req.user.username);
  console.log(`[admin] ${req.user.username} published license terms version ${entry.version}`);
  res.status(201).json(entry);
});

// The current set of optional permissions (enabled and disabled) with who is opted in to each, e.g. the
// recipients of product update emails.
const setWithGrants = async (set) => ({
  ...set,
  permissions: await Promise.all(set.permissions.map(async (p) => ({ ...p, grantedUsers: await grantedUsers(p.id) }))),
});

adminRouter.get('/optional-permissions', async (_req, res) => {
  res.json(await setWithGrants(await currentSet()));
});

// Every change below publishes a new version of the whole set: everyone's choices are reset and every user
// is asked to review all optional permissions again.
const published = async (req, res, set, what) => {
  console.log(`[admin] ${req.user.username} ${what}: optional permissions version ${set.version}`);
  res.json(await setWithGrants(set));
};

adminRouter.post('/optional-permissions', async (req, res) => {
  const { label, description } = req.body ?? {};
  if (typeof label !== 'string' || !label.trim() || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'Missing fields: label and description are required' });
  }
  const set = await createPermission({ label: label.trim(), description: description.trim() }, req.user.username);
  res.status(201);
  await published(req, res, set, `added "${label.trim()}"`);
});

// Edit name/description and/or enable/disable.
adminRouter.put('/optional-permissions/:id', async (req, res) => {
  const { label, description, enabled } = req.body ?? {};
  const changes = {};
  for (const [field, value] of Object.entries({ label, description })) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) return res.status(400).json({ error: `${field} can't be empty` });
    changes[field] = value.trim();
  }
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
    changes.enabled = enabled;
  }
  const set = await updatePermission(req.params.id, changes, req.user.username);
  await published(req, res, set, `updated ${req.params.id}`);
});

// Removed from the new version. Earlier versions keep it, so past choices still make sense.
adminRouter.delete('/optional-permissions/:id', async (req, res) => {
  const set = await deletePermission(req.params.id, req.user.username);
  await published(req, res, set, `deleted ${req.params.id}`);
});
