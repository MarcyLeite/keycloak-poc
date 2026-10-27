import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Every version of the terms ever published. Admins publish new ones from the app (publishTerms), or add an
// entry with a higher version by hand: every user is asked to accept it on their next request. Never edit or
// remove a published version, since acceptances point to it.
const TERMS_FILE = process.env.TERMS_FILE ?? path.resolve('terms.json');
// Who accepted which version and when, one JSON line each. Append-only, so it is also the audit trail.
const ACCEPTANCES_FILE = process.env.TERMS_ACCEPTANCES_FILE ?? path.resolve('logs/terms-acceptances.jsonl');
await mkdir(path.dirname(ACCEPTANCES_FILE), { recursive: true });

// Read on every call, so a new version is live without restarting the backend.
async function allVersions() {
  return JSON.parse(await readFile(TERMS_FILE, 'utf8'));
}

// Newest first.
export async function listTerms() {
  return (await allVersions()).sort((a, b) => b.version - a.version);
}

export async function currentTerms() {
  const versions = await allVersions();
  return versions.reduce((latest, t) => (t.version > latest.version ? t : latest));
}

const escapeHtml = (text) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Admins write plain text, blank lines between paragraphs. It is escaped here, so the HTML every user
// sees can't carry markup or scripts.
const textToHtml = (text) =>
  text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');

// Publishes calls one at a time, so two admins can't both create the same version number.
let publishing = Promise.resolve();

export function publishTerms({ title, text }, publishedBy) {
  const run = publishing.then(async () => {
    const versions = await allVersions();
    const entry = {
      version: Math.max(0, ...versions.map((t) => t.version)) + 1,
      publishedAt: new Date().toISOString(),
      publishedBy,
      title,
      html: textToHtml(text),
    };
    // Written in place (not via rename) so the file keeps its owner on the host.
    await writeFile(TERMS_FILE, JSON.stringify([...versions, entry], null, 2) + '\n');
    return entry;
  });
  publishing = run.catch(() => {});
  return run;
}

// Latest acceptance per user id, loaded once and kept up to date by acceptTerms().
const latestAcceptance = new Map();
try {
  for (const line of (await readFile(ACCEPTANCES_FILE, 'utf8')).split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    latestAcceptance.set(entry.userId, entry);
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

// { version, time } of the newest version the user accepted, or null.
export const acceptanceOf = (userId) => latestAcceptance.get(userId) ?? null;

export async function acceptTerms(user, version) {
  const entry = { time: new Date().toISOString(), userId: user.id, username: user.username, version };
  await appendFile(ACCEPTANCES_FILE, JSON.stringify(entry) + '\n');
  latestAcceptance.set(user.id, entry);
  return entry;
}

// Blocks the API until the user accepted the current version. Mounted after authenticate;
// the routes the terms screen itself needs are registered before it.
export async function requireCurrentTerms(req, res, next) {
  const { version } = await currentTerms();
  if (acceptanceOf(req.user.id)?.version !== version) {
    return res.status(403).json({ error: `License terms version ${version} not accepted`, code: 'terms_not_accepted', version });
  }
  next();
}
