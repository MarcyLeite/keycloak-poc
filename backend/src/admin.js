import { Router } from 'express';
import { TIER_GROUPS, createUser, listUsers, setUserGroup } from './keycloakAdmin.js';
import { acceptanceOf } from './terms.js';

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
