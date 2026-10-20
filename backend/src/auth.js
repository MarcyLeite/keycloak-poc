import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost/auth/realms/poc';
const AUDIENCE = process.env.KEYCLOAK_AUDIENCE ?? 'poc-backend';

// Keys are fetched from Keycloak and cached; rotation is handled automatically.
// Inside Docker the issuer URL isn't reachable, so the keys can come from an internal URL.
const JWKS_URL = process.env.KEYCLOAK_JWKS_URL ?? `${ISSUER}/protocol/openid-connect/certs`;
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export async function authenticate(req, res, next) {
  const header = req.headers.authorization ?? '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
    req.user = {
      username: payload.preferred_username,
      email: payload.email,
      roles: payload.realm_access?.roles ?? [],
      // Scopes the user consented to for this client, e.g. "openid email profile send-email".
      scopes: payload.scope?.split(' ') ?? [],
    };
    next();
  } catch (err) {
    res.status(401).json({ error: `Invalid token: ${err.code ?? err.message}` });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user.roles.includes(role)) {
      return res.status(403).json({ error: `Missing role: ${role}` });
    }
    next();
  };
}

// Roles say what the user may do; scopes say what the user allowed this app to do for them.
export function requireScope(scope) {
  return (req, res, next) => {
    if (!req.user.scopes.includes(scope)) {
      return res.status(403).json({ error: `Missing scope: ${scope} (the user has not granted this permission)` });
    }
    next();
  };
}
