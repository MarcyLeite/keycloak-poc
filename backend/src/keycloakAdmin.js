// Calls the Keycloak Admin REST API as the backend's service account (client credentials).
// The service account only has realm-management: view-users, manage-users, query-groups.

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost/auth';
const REALM = process.env.KEYCLOAK_REALM ?? 'poc';
const CLIENT_ID = process.env.KEYCLOAK_CLIENT_ID ?? 'poc-backend';
const CLIENT_SECRET = process.env.KEYCLOAK_CLIENT_SECRET ?? 'poc-backend-secret';

// Groups that define a user's access tier. A user belongs to exactly one of them.
export const TIER_GROUPS = ['basic', 'premium', 'admin'];

// Client whose consents (granted scopes) the admin panel shows.
const FRONTEND_CLIENT_ID = 'poc-frontend';

export class KeycloakError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

let cached = { token: null, expiresAt: 0 };

async function serviceToken() {
  if (cached.token && Date.now() < cached.expiresAt - 10_000) return cached.token;
  const res = await fetch(`${KEYCLOAK_URL}/realms/${REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new KeycloakError(502, `Service account login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  cached = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return cached.token;
}

async function api(method, path, body) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${REALM}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await serviceToken()}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    // Surface Keycloak's own message for client errors (e.g. 409 "User exists with same username").
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.errorMessage ?? parsed.error ?? text;
    } catch {
      // not JSON
    }
    throw new KeycloakError(res.status < 500 ? res.status : 502, message);
  }
  return text ? JSON.parse(text) : null;
}

const tierOf = (groups) => groups.find((g) => TIER_GROUPS.includes(g.name))?.name ?? null;

export async function listUsers() {
  const users = await api('GET', '/users?max=200');
  return Promise.all(
    users.map(async (u) => {
      const [groups, consents] = await Promise.all([
        api('GET', `/users/${u.id}/groups`),
        api('GET', `/users/${u.id}/consents`),
      ]);
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        group: tierOf(groups),
        // null: the user never consented to the frontend (e.g. never logged in).
        grantedScopes: consents.find((c) => c.clientId === FRONTEND_CLIENT_ID)?.grantedClientScopes ?? null,
      };
    }),
  );
}

export async function setUserGroup(userId, groupName) {
  const groups = await api('GET', '/groups?briefRepresentation=true');
  const target = groups.find((g) => g.name === groupName);
  if (!target || !TIER_GROUPS.includes(groupName)) throw new KeycloakError(400, `Unknown group: ${groupName}`);

  const current = await api('GET', `/users/${userId}/groups`);
  for (const g of current.filter((c) => TIER_GROUPS.includes(c.name) && c.id !== target.id)) {
    await api('DELETE', `/users/${userId}/groups/${g.id}`);
  }
  await api('PUT', `/users/${userId}/groups/${target.id}`);
}

// Hard delete: Keycloak also drops the user's credentials, groups, consents and sessions.
export async function deleteUser(userId) {
  await api('DELETE', `/users/${userId}`);
}

export async function createUser({ username, email, firstName, lastName, password, group }) {
  await api('POST', '/users', { username, email, firstName, lastName, enabled: true, emailVerified: true });
  const [user] = await api('GET', `/users?exact=true&username=${encodeURIComponent(username)}`);
  try {
    await api('PUT', `/users/${user.id}/reset-password`, { type: 'password', value: password, temporary: false });
    await setUserGroup(user.id, group);
  } catch (err) {
    // Don't leave a half-configured user behind (e.g. password rejected by policy).
    await api('DELETE', `/users/${user.id}`).catch(() => {});
    throw err;
  }
  return { id: user.id, username, email, firstName, lastName, group };
}
