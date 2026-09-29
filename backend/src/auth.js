import { createRemoteJWKSet, jwtVerify } from 'jose';

const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/poc';
const AUDIENCE = process.env.KEYCLOAK_AUDIENCE ?? 'poc-backend';

// Keys are fetched from Keycloak and cached; rotation is handled automatically.
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/protocol/openid-connect/certs`));

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
      roles: payload.realm_access?.roles ?? [],
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
