import { Router } from 'express';
import { TIER_GROUPS, createUser, listUsers, setUserGroup } from './keycloakAdmin.js';
import { acceptanceOf, listTerms, publishTerms } from './terms.js';
import { createPermission, deletePermission, grantedUsers, listPermissions } from './optionalPermissions.js';

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

// Optional permissions with who is opted in to each, e.g. the recipients of product update emails.
adminRouter.get('/optional-permissions', async (_req, res) => {
  const permissions = await listPermissions();
  res.json(permissions.map((p) => ({ ...p, grantedUsers: grantedUsers(p.id) })));
});

// New permissions start off for everyone: users opt in themselves.
adminRouter.post('/optional-permissions', async (req, res) => {
  const { label, description } = req.body ?? {};
  if (typeof label !== 'string' || !label.trim() || typeof description !== 'string' || !description.trim()) {
    return res.status(400).json({ error: 'Missing fields: label and description are required' });
  }
  const permission = await createPermission({ label: label.trim(), description: description.trim() }, req.user.username);
  console.log(`[admin] ${req.user.username} added optional permission ${permission.id}`);
  res.status(201).json(permission);
});

// Soft delete: users stop seeing it and nobody counts as opted in, but past choices stay on record.
adminRouter.delete('/optional-permissions/:id', async (req, res) => {
  const permission = await deletePermission(req.params.id, req.user.username);
  console.log(`[admin] ${req.user.username} deleted optional permission ${permission.id}`);
  res.json(permission);
});
