#!/usr/bin/env node
// Populates the "poc" realm through the Keycloak Admin REST API.
// Idempotent: missing objects are created, existing ones are updated in place.
//
//   node keycloak/seed.mjs
//
// Env: KEYCLOAK_URL (default http://localhost/auth), KEYCLOAK_ADMIN / KEYCLOAK_ADMIN_PASSWORD (default admin/admin),
//      BACKEND_CLIENT_SECRET (default poc-backend-secret)

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'http://localhost/auth';
const ADMIN_USER = process.env.KEYCLOAK_ADMIN ?? 'admin';
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
const REALM = 'poc';
const FRONTEND_URL = 'http://localhost';
// Secret the backend uses for its service account (client credentials). Dev-only default.
const BACKEND_CLIENT_SECRET = process.env.BACKEND_CLIENT_SECRET ?? 'poc-backend-secret';

const config = {
  realm: {
    realm: REALM,
    displayName: 'Keycloak PoC',
    loginTheme: 'poc',
    enabled: true,
    sslRequired: 'none',
    registrationAllowed: false,
    accessTokenLifespan: 300,
  },
  roles: [
    { name: 'math-1', description: 'Can call sum' },
    { name: 'math-2', description: 'Can call multiply' },
    { name: 'math-3', description: 'Can call power' },
    { name: 'admin', description: 'Can create users and assign their group' },
  ],
  // Keycloak's built-in Terms and Conditions action is turned off: the app shows versioned terms itself
  // (backend/terms.json). Kept here so re-running the seed also disables it on existing realms.
  requiredActions: [{ alias: 'TERMS_AND_CONDITIONS', enabled: false, defaultAction: false }],
  // Custom permissions the SPA can ask for. Each one is listed on Keycloak's consent screen and,
  // once granted, appears in the access token's `scope` claim.
  clientScopes: [
    {
      name: 'send-email',
      description: 'Send emails on the user\'s behalf',
      protocol: 'openid-connect',
      attributes: {
        'display.on.consent.screen': 'true',
        'consent.screen.text': 'Send emails on your behalf',
        'include.in.token.scope': 'true',
      },
    },
    {
      name: 'read-contacts',
      description: 'Read the user\'s contacts',
      protocol: 'openid-connect',
      attributes: {
        'display.on.consent.screen': 'true',
        'consent.screen.text': 'Read your contacts',
        'include.in.token.scope': 'true',
      },
    },
  ],
  groups: [
    { name: 'basic', roles: ['math-1'] },
    { name: 'premium', roles: ['math-1', 'math-2', 'math-3'] },
    { name: 'admin', roles: ['math-1', 'math-2', 'math-3', 'admin'] },
  ],
  clients: [
    {
      clientId: 'poc-frontend',
      name: 'PoC Frontend (SPA)',
      enabled: true,
      publicClient: true,
      protocol: 'openid-connect',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      // Users must approve the scopes this client gets (profile, email, roles...) on a consent screen.
      consentRequired: true,
      // Not granted at login: the SPA asks for them later with scope=..., which shows the consent screen again.
      optionalClientScopes: ['send-email', 'read-contacts'],
      redirectUris: [`${FRONTEND_URL}/*`],
      webOrigins: [FRONTEND_URL],
      attributes: {
        'pkce.code.challenge.method': 'S256',
        'post.logout.redirect.uris': `${FRONTEND_URL}/*`,
      },
      protocolMappers: [
        {
          name: 'audience-poc-backend',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-audience-mapper',
          config: {
            'included.client.audience': 'poc-backend',
            'id.token.claim': 'false',
            'access.token.claim': 'true',
          },
        },
      ],
      // Deleted if present, for realms seeded before the terms moved into the app.
      removedProtocolMappers: ['terms-accepted-at'],
    },
    {
      clientId: 'poc-backend',
      name: 'PoC Backend (resource server)',
      enabled: true,
      publicClient: false,
      clientAuthenticatorType: 'client-secret',
      secret: BACKEND_CLIENT_SECRET,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      // Service account lets the backend call the Admin API on behalf of admin users.
      serviceAccountsEnabled: true,
      serviceAccountRoles: {
        'realm-management': ['view-users', 'manage-users', 'query-groups'],
      },
    },
  ],
  users: [
    {
      username: 'alice',
      password: 'alice',
      email: 'alice@example.com',
      firstName: 'Alice',
      lastName: 'Premium',
      groups: ['premium'],
    },
    {
      username: 'bob',
      password: 'bob',
      email: 'bob@example.com',
      firstName: 'Bob',
      lastName: 'Basic',
      groups: ['basic'],
    },
    {
      username: 'carol',
      password: 'carol',
      email: 'carol@example.com',
      firstName: 'Carol',
      lastName: 'Admin',
      groups: ['admin'],
    },
  ],
};

let token;

const log = (action, kind, name) => console.log(`${action.padEnd(8)} ${kind.padEnd(7)} ${name}`);

async function api(method, path, body) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  if (method === 'GET' && res.status === 404) return null;
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function waitForKeycloak(timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${KEYCLOAK_URL}/realms/master`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`Keycloak not reachable at ${KEYCLOAK_URL}`);
}

async function login() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    }),
  });
  if (!res.ok) throw new Error(`Admin login failed: ${res.status} ${await res.text()}`);
  token = (await res.json()).access_token;
}

async function upsertRealm() {
  if (await api('GET', `/${REALM}`)) {
    await api('PUT', `/${REALM}`, config.realm);
    log('updated', 'realm', REALM);
  } else {
    await api('POST', '', config.realm);
    log('created', 'realm', REALM);
  }
}

async function upsertRoles() {
  for (const role of config.roles) {
    if (await api('GET', `/${REALM}/roles/${role.name}`)) {
      await api('PUT', `/${REALM}/roles/${role.name}`, role);
      log('updated', 'role', role.name);
    } else {
      await api('POST', `/${REALM}/roles`, role);
      log('created', 'role', role.name);
    }
  }
}

async function upsertRequiredActions() {
  for (const action of config.requiredActions) {
    const path = `/${REALM}/authentication/required-actions/${action.alias}`;
    await api('PUT', path, { ...(await api('GET', path)), ...action });
    log('updated', 'action', action.alias);
    if (!action.enabled) await clearRequiredAction(action.alias);
  }
}

// Removes a turned-off required action from users who still have it pending, so it can't block their login.
async function clearRequiredAction(alias) {
  const users = await api('GET', `/${REALM}/users?max=1000&briefRepresentation=false`);
  for (const user of users.filter((u) => u.requiredActions.includes(alias))) {
    // Send the whole user back: the Admin API clears fields missing from a PUT.
    await api('PUT', `/${REALM}/users/${user.id}`, { ...user, requiredActions: user.requiredActions.filter((a) => a !== alias) });
    log('cleared', 'action', `${alias} on ${user.username}`);
  }
}

const findClientScope = async (name) =>
  (await api('GET', `/${REALM}/client-scopes`)).find((s) => s.name === name);

async function upsertClientScopes() {
  for (const scope of config.clientScopes) {
    const existing = await findClientScope(scope.name);
    if (existing) {
      await api('PUT', `/${REALM}/client-scopes/${existing.id}`, { ...existing, ...scope });
      log('updated', 'scope', scope.name);
    } else {
      await api('POST', `/${REALM}/client-scopes`, scope);
      log('created', 'scope', scope.name);
    }
  }
}

const findClient = async (clientId) =>
  (await api('GET', `/${REALM}/clients?clientId=${encodeURIComponent(clientId)}`))[0];

async function upsertClients() {
  for (const { protocolMappers = [], removedProtocolMappers = [], optionalClientScopes = [], serviceAccountRoles = {}, ...client } of config.clients) {
    const existing = await findClient(client.clientId);
    if (existing) {
      await api('PUT', `/${REALM}/clients/${existing.id}`, {
        ...existing,
        ...client,
        attributes: { ...existing.attributes, ...client.attributes },
      });
      log('updated', 'client', client.clientId);
    } else {
      await api('POST', `/${REALM}/clients`, client);
      log('created', 'client', client.clientId);
    }

    const { id } = await findClient(client.clientId);
    const mappersPath = `/${REALM}/clients/${id}/protocol-mappers/models`;
    const currentMappers = await api('GET', mappersPath);
    for (const mapper of protocolMappers) {
      const found = currentMappers.find((m) => m.name === mapper.name);
      if (found) {
        await api('PUT', `${mappersPath}/${found.id}`, { ...found, ...mapper });
        log('updated', 'mapper', `${client.clientId}/${mapper.name}`);
      } else {
        await api('POST', mappersPath, mapper);
        log('created', 'mapper', `${client.clientId}/${mapper.name}`);
      }
    }
    for (const mapper of currentMappers.filter((m) => removedProtocolMappers.includes(m.name))) {
      await api('DELETE', `${mappersPath}/${mapper.id}`);
      log('deleted', 'mapper', `${client.clientId}/${mapper.name}`);
    }

    const optionalPath = `/${REALM}/clients/${id}/optional-client-scopes`;
    const currentOptional = await api('GET', optionalPath);
    for (const name of optionalClientScopes.filter((n) => !currentOptional.some((s) => s.name === n))) {
      const scope = await findClientScope(name);
      await api('PUT', `${optionalPath}/${scope.id}`);
      log('added', 'scope', `${client.clientId} optional: ${name}`);
    }

    // Grant client roles (e.g. realm-management/manage-users) to the client's service account.
    for (const [roleClientId, roleNames] of Object.entries(serviceAccountRoles)) {
      const saUser = await api('GET', `/${REALM}/clients/${id}/service-account-user`);
      const roleClient = await findClient(roleClientId);
      const roles = await Promise.all(
        roleNames.map((r) => api('GET', `/${REALM}/clients/${roleClient.id}/roles/${r}`)),
      );
      await api('POST', `/${REALM}/users/${saUser.id}/role-mappings/clients/${roleClient.id}`, roles);
      log('granted', 'sa-role', `${client.clientId} -> ${roleClientId}: ${roleNames.join(', ')}`);
    }
  }
}

// Sync managed realm roles on a user or group: add missing, remove ones no longer listed.
// Roles not defined in config (e.g. default-roles-poc) are left untouched.
async function syncRealmRoles(mappingsPath, roles) {
  const managedRoles = config.roles.map((r) => r.name);
  const current = await api('GET', mappingsPath);
  const currentNames = current.map((r) => r.name);
  const toAdd = await Promise.all(
    roles.filter((r) => !currentNames.includes(r)).map((r) => api('GET', `/${REALM}/roles/${r}`)),
  );
  const toRemove = current.filter((r) => managedRoles.includes(r.name) && !roles.includes(r.name));
  if (toAdd.length) await api('POST', mappingsPath, toAdd);
  if (toRemove.length) await api('DELETE', mappingsPath, toRemove);
}

const findGroup = async (name) =>
  (await api('GET', `/${REALM}/groups?briefRepresentation=true`)).find((g) => g.name === name);

async function upsertGroups() {
  for (const { name, roles } of config.groups) {
    if (await findGroup(name)) {
      log('exists', 'group', name);
    } else {
      await api('POST', `/${REALM}/groups`, { name });
      log('created', 'group', name);
    }
    const { id } = await findGroup(name);
    await syncRealmRoles(`/${REALM}/groups/${id}/role-mappings/realm`, roles);
  }
}

const findUser = async (username) =>
  (await api('GET', `/${REALM}/users?exact=true&username=${encodeURIComponent(username)}`))[0];

async function upsertUsers() {
  const managedGroups = config.groups.map((g) => g.name);

  for (const { password, groups, ...fields } of config.users) {
    const user = { ...fields, enabled: true, emailVerified: true };
    const existing = await findUser(user.username);
    if (existing) {
      await api('PUT', `/${REALM}/users/${existing.id}`, user);
      log('updated', 'user', user.username);
    } else {
      await api('POST', `/${REALM}/users`, user);
      log('created', 'user', user.username);
    }

    const { id } = await findUser(user.username);
    await api('PUT', `/${REALM}/users/${id}/reset-password`, { type: 'password', value: password, temporary: false });

    // Permissions come from groups only: drop any managed roles assigned directly to the user.
    await syncRealmRoles(`/${REALM}/users/${id}/role-mappings/realm`, []);

    // Sync managed group membership: join missing, leave ones no longer listed.
    const current = await api('GET', `/${REALM}/users/${id}/groups`);
    for (const name of groups.filter((g) => !current.some((c) => c.name === g))) {
      const group = await findGroup(name);
      await api('PUT', `/${REALM}/users/${id}/groups/${group.id}`);
    }
    for (const group of current.filter((c) => managedGroups.includes(c.name) && !groups.includes(c.name))) {
      await api('DELETE', `/${REALM}/users/${id}/groups/${group.id}`);
    }
  }
}

await waitForKeycloak();
await login();
await upsertRealm();
await upsertRequiredActions();
await upsertRoles();
await upsertGroups();
await upsertClientScopes();
await upsertClients();
await upsertUsers();
console.log(`\nDone. Realm "${REALM}" is ready at ${KEYCLOAK_URL}/realms/${REALM}`);
