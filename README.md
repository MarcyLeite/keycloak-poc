# Keycloak PoC

Checks that Keycloak can act as the OAuth2/OIDC provider for a web app.

| Part       | Tech                          | URL                     |
|------------|-------------------------------|-------------------------|
| Keycloak   | Docker Compose, realm `poc` seeded via Admin API | http://localhost:8080 |
| Backend    | Node + Express + `jose`       | http://localhost:3000   |
| Frontend   | Vite + `keycloak-js`          | http://localhost:5173   |

## Run

```bash
docker compose up -d                        # Keycloak
node keycloak/seed.mjs                      # create realm, roles, clients, users
cd backend  && npm install && npm run dev   # terminal 1
cd frontend && npm install && npm run dev   # terminal 2
```

Open http://localhost:5173 and log in.

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

Keycloak admin console: http://localhost:8080/admin (`admin` / `admin`).

## How it works

1. The SPA (`poc-frontend`, public client) logs in with **Authorization Code + PKCE (S256)**.
2. An audience mapper adds `poc-backend` to the access token's `aud`.
3. The SPA calls the API with `Authorization: Bearer <access_token>`, refreshing the token beforehand if needed.
4. The backend verifies the JWT against Keycloak's JWKS (signature, `iss`, `aud`, `exp`) and checks
   `realm_access.roles` for each endpoint.

## User management (admin)

Log in as `carol` to see the **Admin · Users** panel. From there you can create a user and pick their group,
or move an existing user to another group.

The browser never calls the Keycloak Admin API itself:

1. The frontend calls `/api/admin/*` on our backend with the admin's access token.
2. The backend checks for the `admin` realm role (403 otherwise).
3. The backend calls the Keycloak Admin API as its **service account** (`poc-backend`, client credentials).
   That account only has `realm-management` roles `view-users`, `manage-users` and `query-groups`.

Backend env (defaults match the seed): `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`.

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

Responses: `401` missing or invalid token, `403` missing role, `400` invalid input, `409` user already exists.

## Seeding Keycloak

`keycloak/seed.mjs` configures the realm through the Keycloak Admin REST API (no dependencies, Node 18+).
It waits for Keycloak, logs in as the master-realm admin, then creates or updates:

- realm `poc`
- realm roles `math-1`, `math-2`, `math-3`
- groups `basic`, `premium` and `admin` and the roles each one grants
- the `poc-backend` service account and its `realm-management` roles
- clients `poc-frontend` (with the `poc-backend` audience mapper) and `poc-backend`
- users `alice`, `bob` and `carol`, their passwords, and their group membership (any `math-*` roles assigned directly to a user are removed, so groups are the only source)

It is idempotent, so edit the `config` object at the top of the script and re-run it to apply changes.

```bash
node keycloak/seed.mjs
KEYCLOAK_URL=http://other-host:8080 KEYCLOAK_ADMIN=admin KEYCLOAK_ADMIN_PASSWORD=secret node keycloak/seed.mjs
```

Keycloak runs in dev mode with no volume, so `docker compose down` wipes it. Run the seed again after `up`.
