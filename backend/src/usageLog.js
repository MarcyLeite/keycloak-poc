import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const LOG_FILE = process.env.USAGE_LOG_FILE ?? path.resolve('logs/usage.jsonl');
await mkdir(path.dirname(LOG_FILE), { recursive: true });

// Appends one JSON line per API request once the response is sent, so it captures the final status
// (including 401/403) and the user that `authenticate` attached later in the chain.
// Request bodies are not logged: admin requests can carry passwords.
export function usageLog(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const entry = {
      time: new Date().toISOString(),
      user: req.user?.username ?? null,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      query: req.query,
      status: res.statusCode,
      durationMs: Number(process.hrtime.bigint() - start) / 1e6,
    };
    appendFile(LOG_FILE, JSON.stringify(entry) + '\n').catch((err) => console.error('[usage-log]', err));
  });
  next();
}
