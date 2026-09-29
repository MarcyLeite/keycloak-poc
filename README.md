# Keycloak PoC

Checks that Keycloak can act as the OAuth2/OIDC provider for a web app.

Everything runs in Docker Compose behind **nginx**, so the browser and all services use one origin:
**http://localhost**.

| Path                          | Service                                           |
|-------------------------------|---------------------------------------------------|
| http://localhost/             | Frontend: Vite + `keycloak-js`                    |
| http://localhost/api/         | Backend: Node + Express + `jose`                  |
| http://localhost/auth/        | Keycloak, realm `poc` (seeded via the Admin API)  |
| http://localhost/auth/admin   | Keycloak admin console (`admin` / `admin`)        |

Only nginx publishes a port (80). Because everything shares one origin, no CORS setup is needed.
Inside Docker, the backend reaches Keycloak directly at `keycloak:8080`, but still expects the public
issuer `http://localhost/auth/realms/poc` in tokens.

## Prerequisites

- Docker with Compose
- Node 18+ on the host (only for the seed script)
- Port 80 free

## Run

```bash
docker compose up -d        # nginx, Keycloak, backend, frontend
node keycloak/seed.mjs      # create realm, roles, groups, clients, users (runs on the host, through nginx)
```

Open http://localhost and log in. The backend and frontend containers mount the source folders and reload on change.
Logs: `docker compose logs -f backend frontend`.

## Project layout

```
compose.yaml                 nginx, Keycloak, backend, frontend
nginx/default.conf           routes /, /api/, /auth/ to the right container
keycloak/seed.mjs            realm setup through the Keycloak Admin API
keycloak/themes/poc/         branded login theme (CSS only)
backend/src/server.js        Express app: math endpoints, error handling
backend/src/auth.js          JWT validation (JWKS, iss, aud) and role checks
backend/src/admin.js         /api/admin/* routes (admin role only)
backend/src/keycloakAdmin.js Keycloak Admin API client (service account)
frontend/src/main.js         keycloak-js login, calculator, admin panel
```

## Login page

Keycloak's login pages use the custom `poc` theme (`keycloak/themes/poc`), which matches the app's look.
It extends the built-in `keycloak.v2` theme and only overrides CSS, so every Keycloak login flow
(errors, password reset, required actions) keeps working. The title comes from the realm's `displayName`.

Edit `keycloak/themes/poc/login/resources/css/poc.css`. Keycloak runs in dev mode with theme caching off,
so changes show up on refresh.

## Users, groups & roles

Each endpoint requires one realm role. Users don't get roles directly: they get them from their group.

| Group     | Roles                        | sum | multiply | power |
|-----------|------------------------------|-----|----------|-------|
| `basic`   | `math-1`                     | ✅  | 403      | 403   |
| `premium` | `math-1`, `math-2`, `math-3` | ✅  | ✅       | ✅    |
| `admin`   | `math-1`, `math-2`, `math-3`, `admin` | ✅ | ✅  | ✅    |

The `admin` role also unlocks user management (see below).

| User  | Password | Group     |
|-------|----------|-----------|
| alice | alice    | `premium` |
| bob   | bob      | `basic`   |
| carol | carol    | `admin`   |

## How it works

1. The SPA (`poc-frontend`, public client) logs in with **Authorization Code + PKCE (S256)**.
2. An audience mapper adds `poc-backend` to the access token's `aud`.
3. The SPA calls the API with `Authorization: Bearer <access_token>`, refreshing the token beforehand if needed.
4. The backend verifies the JWT against Keycloak's JWKS (signature, `iss`, `aud`, `exp`) and checks
   `realm_access.roles` for each endpoint.

Roles live in the access token, so a group change reaches a user on their next token refresh
(access tokens last 5 minutes) or next login.

## User management (admin)

Log in as `carol` to see the **Admin · Users** panel. From there you can create a user and pick their group,
or move an existing user to another group.

The browser never calls the Keycloak Admin API itself:

1. The frontend calls `/api/admin/*` on our backend with the admin's access token.
2. The backend checks for the `admin` realm role (403 otherwise).
3. The backend calls the Keycloak Admin API as its **service account** (`poc-backend`, client credentials).
   That account only has `realm-management` roles `view-users`, `manage-users` and `query-groups`.

Backend env (set in `compose.yaml`): `KEYCLOAK_ISSUER`, `KEYCLOAK_JWKS_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`.

## API

All endpoints except `/api/health` require a valid token. Operands are `a` and `b` query params.

| Endpoint                   | Role         | Result   |
|----------------------------|--------------|----------|
| `GET /api/health`          | —            | `ok`     |
| `GET /api/me`              | any          | user + roles |
| `GET /api/sum?a=2&b=8`     | `math-1`     | `10`     |
| `GET /api/multiply?a=2&b=8`| `math-2`     | `16`     |
| `GET /api/power?a=2&b=8`   | `math-3`     | `256`    |
| `GET /api/admin/users`     | `admin`      | users with their group |
| `POST /api/admin/users`    | `admin`      | create user: `{username, email, firstName, lastName, password, group}` |
| `PUT /api/admin/users/:id/group` | `admin` | set group: `{group}` |

Responses: `401` missing or invalid token, `403` missing role, `400` invalid input, `404` unknown user,
`409` username or email already taken.

## Seeding Keycloak

`keycloak/seed.mjs` configures the realm through the Keycloak Admin REST API (no dependencies, Node 18+).
It waits for Keycloak, logs in as the master-realm admin, then creates or updates:

- realm `poc` (display name and the `poc` login theme)
- realm roles `math-1`, `math-2`, `math-3`, `admin`
- groups `basic`, `premium` and `admin` and the roles each one grants
- clients `poc-frontend` (with the `poc-backend` audience mapper) and `poc-backend`
- the `poc-backend` service account and its `realm-management` roles
- users `alice`, `bob` and `carol`, their passwords, and their group membership (any `math-*` roles assigned directly to a user are removed, so groups are the only source)

It is idempotent, so edit the `config` object at the top of the script and re-run it to apply changes.

```bash
node keycloak/seed.mjs
KEYCLOAK_URL=http://other-host/auth KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=secret node keycloak/seed.mjs
```

Keycloak runs in dev mode with no volume, so `docker compose down` wipes it. Run the seed again after `up`.

## Not for production

This is a local PoC: Keycloak runs in dev mode over plain HTTP (`sslRequired: none`). The admin login
(`admin` / `admin`), the `poc-backend` client secret and the user passwords are fixed dev values.
