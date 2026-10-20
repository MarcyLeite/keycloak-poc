import express from 'express';
import { authenticate, requireRole, requireScope } from './auth.js';
import { adminRouter } from './admin.js';
import { KeycloakError } from './keycloakAdmin.js';

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

app.use('/api', authenticate);

app.get('/api/me', (req, res) => res.json(req.user));

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
  if (err instanceof KeycloakError) return res.status(err.status).json({ error: err.message });
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message }); // e.g. bad JSON
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => console.log(`Backend listening on http://localhost:${PORT}`));
