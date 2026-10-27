import express from 'express';
import { authenticate, requireRole, requireScope } from './auth.js';
import { adminRouter } from './admin.js';
import { KeycloakError, deleteUser } from './keycloakAdmin.js';
import { logDeletion } from './deletionLog.js';
import { usageLog } from './usageLog.js';
import { acceptTerms, acceptanceOf, currentTerms, requireCurrentTerms } from './terms.js';
import { PermissionError, permissionsFor, revokeAll, setChoice } from './optionalPermissions.js';

const PORT = process.env.PORT ?? 3000;
const app = express();

app.use(express.json());

function parseOperands(req, res) {
  const { a, b } = req.query;
  const values = [Number(a), Number(b)];
  if (a === undefined || b === undefined || values.some(Number.isNaN)) {
    res.status(400).json({ error: 'Query params a and b must be numbers' });
    return null;
  }
  return values;
}

app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api', usageLog, authenticate);

app.get('/api/me', (req, res) => res.json(req.user));

// The user deletes their own account. It is written to the deletion log first, so a deletion is never
// lost: if the Keycloak call fails, or a backup is restored later, keycloak/replay-deletions.mjs redoes it.
app.delete('/api/me', async (req, res) => {
  await logDeletion({ userId: req.user.id, username: req.user.username, deletedBy: req.user.username });
  await revokeAll(req.user);
  await deleteUser(req.user.id);
  console.log(`[account] ${req.user.username} deleted their account`);
  res.json({ deleted: true, id: req.user.id });
});

// The terms screen: the current version and what this user accepted last.
app.get('/api/terms', async (req, res) => {
  res.json({ current: await currentTerms(), accepted: acceptanceOf(req.user.id) });
});

// The client sends the version it showed, so a user never accepts a text they didn't see.
app.post('/api/terms/accept', async (req, res) => {
  const { version } = await currentTerms();
  if (req.body?.version !== version) {
    return res.status(409).json({ error: `Terms changed: the current version is ${version}`, version });
  }
  const entry = await acceptTerms(req.user, version);
  console.log(`[terms] ${req.user.username} accepted version ${version}`);
  res.json(entry);
});

// Everything below needs the current terms accepted. /api/me and /api/terms stay open so the user
// can see and accept the terms, or delete their account without accepting.
app.use('/api', requireCurrentTerms);

// Optional permissions: the user's own choices. Turning one off never blocks anything.
app.get('/api/optional-permissions', async (req, res) => {
  res.json(await permissionsFor(req.user.id));
});

app.put('/api/optional-permissions/:id', async (req, res) => {
  const { granted, version } = req.body ?? {};
  if (typeof granted !== 'boolean' || !Number.isInteger(version)) {
    return res.status(400).json({ error: 'Body must be {"granted": true|false, "version": <number>}' });
  }
  const choice = await setChoice(req.user, req.params.id, granted, version);
  console.log(`[optional-permission] ${req.user.username} turned ${granted ? 'on' : 'off'} ${req.params.id}`);
  res.json(choice);
});

app.get('/api/sum', requireRole('math-1'), (req, res) => {
  const ops = parseOperands(req, res);
  if (ops) res.json({ operation: 'sum', a: ops[0], b: ops[1], result: ops[0] + ops[1], by: req.user.username });
});

app.get('/api/multiply', requireRole('math-2'), (req, res) => {
  const ops = parseOperands(req, res);
  if (ops) res.json({ operation: 'multiply', a: ops[0], b: ops[1], result: ops[0] * ops[1], by: req.user.username });
});

app.get('/api/power', requireRole('math-3'), (req, res) => {
  const ops = parseOperands(req, res);
  if (ops) res.json({ operation: 'power', a: ops[0], b: ops[1], result: ops[0] ** ops[1], by: req.user.username });
});

// Demo endpoints guarded by consent scopes instead of roles. Nothing is really sent or stored.
app.post('/api/email/send', requireScope('send-email'), (req, res) => {
  console.log(`[email] would send a test email to ${req.user.email} for ${req.user.username}`);
  res.json({ simulated: true, to: req.user.email, subject: 'Hello from the Keycloak PoC' });
});

app.get('/api/contacts', requireScope('read-contacts'), (req, res) => {
  res.json({
    owner: req.user.username,
    contacts: [
      { name: 'Ada Lovelace', email: 'ada@example.com' },
      { name: 'Alan Turing', email: 'alan@example.com' },
    ],
  });
});

app.use('/api/admin', requireRole('admin'), adminRouter);

// Express 5 forwards rejected promises from async handlers here.
app.use((err, _req, res, _next) => {
  if (err instanceof KeycloakError || err instanceof PermissionError) return res.status(err.status).json({ error: err.message });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message }); // e.g. bad JSON
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
