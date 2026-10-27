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
keycloak/replay-deletions.mjs re-deletes logged account deletions after a backup restore
keycloak/themes/poc/         branded login theme (CSS)
backend/src/server.js        Express app: math endpoints, error handling
backend/src/auth.js          JWT validation (JWKS, iss, aud) and role checks
backend/src/admin.js         /api/admin/* routes (admin role only)
backend/src/keycloakAdmin.js Keycloak Admin API client (service account)
backend/src/usageLog.js      per-request usage log (logs/usage.jsonl)
backend/src/deletionLog.js   deleted accounts log (logs/deletions.jsonl)
backend/src/terms.js         versioned license terms and acceptances
backend/terms.json           every published version of the license terms
backend/src/optionalPermissions.js optional permissions and users' choices
backend/optional-permissions.json  the optional permissions admins manage
frontend/src/main.js         keycloak-js login, calculator, admin panel
```

## Login page

Keycloak's login pages use the custom `poc` theme (`keycloak/themes/poc`), which matches the app's look.
It extends the built-in `keycloak.v2` theme and only overrides CSS and a few messages, so every Keycloak login flow
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

## License terms

Every user must accept the current license terms before using the app. The terms are versioned in
`backend/terms.json`, and the app shows them itself, right after the Keycloak login (Keycloak's built-in
Terms and Conditions action is turned off).

- **Publish a new version**: admins use the **Admin · License terms** panel. It starts from the current text;
  edit it (plain text, blank lines between paragraphs) and publish. The backend appends a new entry with the next
  `version`, the time and the admin's username to `backend/terms.json`, escaping the text into HTML. Earlier
  versions are never changed. Every user, the admin included, is asked to accept it on their next request.
  You can also add an entry by hand; it's live right away, no restart needed. Never edit or remove a published
  version: acceptances point to it.
- **Accept**: the backend appends `{time, userId, username, version}` to `backend/logs/terms-acceptances.jsonl`.
  That file is the record of who accepted which version and when. The client sends the version it showed, and
  the backend rejects it (`409`) if a newer one was published in the meantime.
- **Decline**: the user is logged out.
- **Until they accept**, the backend answers `403` with `code: "terms_not_accepted"` on every endpoint except
  `/api/me` and `/api/terms*`. The terms screen can't be skipped by calling the API directly, and a user can
  still delete their account without accepting.

The admin panel shows the version each user accepted, and every published version with who published it.
`backend/terms.json` is tracked by git, so versions published from the app show up as changes to commit.

## Optional permissions

Things a user can agree to without being required to, like **Product update emails**, the **Monthly newsletter**
and **Usage analytics** (the three defaults). They don't block anything: saying no never limits what the user
can do in the app.

- **Users** turn each one on or off at any time under **Optional permissions**. All are off until the user turns
  them on (opt-in), the safe default for consent under GDPR-style rules.
- **Asked again on change**: each permission has a `revision`, and a user's choice only counts for the revision
  they saw. Adding a permission, editing its name or description, or enabling it again starts a new revision.
  Everyone's choice for it is reset: they count as not opted in, and after login (after the license terms) the
  app shows the new or changed permissions to choose from. Unlike the terms, users can **Decide later**; the
  screen comes back on the next visit. The client sends the revision it showed, and the backend rejects it
  (`409`) if the permission changed in the meantime. Earlier texts are kept in the permission's `history`.
- **Admins** manage them in the **Admin · Optional permissions** panel: add, edit, enable/disable and delete,
  and see who is opted in to each one, e.g. who to send product update emails to.
  - **Disable** hides it from users and nobody counts as opted in, without resetting anything. Enabling it again
    starts a new revision, so everyone is asked again.
  - **Delete** is a soft delete: it gets `deletedAt`/`deletedBy` in the file, users stop seeing it, and nobody
    counts as opted in, but past choices stay on record. Ids are never reused.
- **Storage**: the list is `backend/optional-permissions.json` (tracked by git, like the terms). Every choice is
  appended to `backend/logs/permission-choices.jsonl` as `{time, userId, username, permissionId, revision, granted}`,
  so you can always see who agreed to which text and when.
- **Account deletion** turns off everything the user had opted in to before the account is deleted.

To check one in code, e.g. before sending an email: `await grantedUsers('product-updates')` in
`backend/src/optionalPermissions.js` returns everyone opted in to the current revision right now.

These are different from the OAuth scopes below: scopes control what the app may do *with Keycloak's token*,
and are asked for on Keycloak's consent screen.

## Permissions (consent)

`poc-frontend` has **Consent Required** on, so on first login Keycloak shows a consent screen listing what the
app gets: user profile, user roles, email address. If the user clicks **No**, the login is cancelled.

The app can also ask for two extra permissions. Each is an *optional client scope* with its own consent text:

| Scope           | Consent screen text          | Backend endpoint           |
|-----------------|------------------------------|----------------------------|
| `send-email`    | Send emails on your behalf   | `POST /api/email/send` (simulated) |
| `read-contacts` | Read your contacts           | `GET /api/contacts` (fake data)    |

They aren't requested at login. The **Permissions** panel has an **Allow…** button for each one. It logs in again with
`scope=openid <scope>`, and Keycloak shows a consent screen for just that new permission.

How to check what a user granted:

- **In the token**: the access token's `scope` claim, e.g. `openid profile email send-email`. The backend checks it
  with `requireScope()` and answers `403 Missing scope: ...` when a permission wasn't granted (roles say what a user
  *may* do; scopes say what the user *allowed this app* to do).
- **Admin panel**: the *Granted scopes* column, read from the Admin API (`GET /users/{id}/consents`).
- **The user**: Keycloak account console → *Applications* (button *Review or revoke in Keycloak account*) lists
  each grant and lets the user remove access.

Keycloak only puts an optional scope in the token when the app asks for it, so the frontend remembers granted
optional scopes in `localStorage` and asks for them again on every login.

## User management (admin)

Log in as `carol` to see the **Admin · Users** panel. From there you can create a user and pick their group,
or move an existing user to another group. The table also shows which version of the license terms each user
accepted and which scopes they granted to the frontend.

The browser never calls the Keycloak Admin API itself:

1. The frontend calls `/api/admin/*` on our backend with the admin's access token.
2. The backend checks for the `admin` realm role (403 otherwise).
3. The backend calls the Keycloak Admin API as its **service account** (`poc-backend`, client credentials).
   That account only has `realm-management` roles `view-users`, `manage-users` and `query-groups`.

Backend env (set in `compose.yaml`): `KEYCLOAK_ISSUER`, `KEYCLOAK_JWKS_URL`, `KEYCLOAK_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET`.

## Logs and account deletion

The backend writes JSON-lines files (one JSON object per line) under `backend/logs/`, which is git-ignored.
The container runs as root, so the files belong to root on the host. Clear them with
`docker compose exec backend rm logs/<file>`.

- **`usage.jsonl`**: one line per `/api` request, written after the response is sent, so rejected calls (401/403)
  are logged too: time, user, method, path, query, status and duration. Request bodies are not logged, because
  admin requests can carry passwords. Path: `USAGE_LOG_FILE`.
- **`terms-acceptances.jsonl`**: see [License terms](#license-terms).
- **`permission-choices.jsonl`**: see [Optional permissions](#optional-permissions).
- **`deletions.jsonl`**: one line per deleted account: time, user ID (`sub`), username and who deleted it.
  Path: `DELETION_LOG_FILE`.

Any user can delete their own account with **Delete my account** (`DELETE /api/me`). The backend writes to the
deletion log first, then deletes the user through the Admin API. Keycloak hard-deletes the user, along with their
credentials, groups, consents and sessions. An access token they already have is still accepted until it expires
(5 minutes).

**Restoring a backup brings deleted users back.** The deletion log is kept outside Keycloak's database for that
reason. After a restore, and before letting users back in, run:

```bash
node keycloak/replay-deletions.mjs               # reads backend/logs/deletions.jsonl
```

Running it twice is safe: users that are already gone are skipped. Re-running `seed.mjs` recreates `alice`, `bob`
and `carol` even if they deleted their accounts.

## API

All endpoints except `/api/health` require a valid token, and all except `/api/me` and `/api/terms*`
require the current license terms to be accepted. Operands are `a` and `b` query params.

| Endpoint                   | Role         | Result   |
|----------------------------|--------------|----------|
| `GET /api/health`          | —            | `ok`     |
| `GET /api/me`              | any          | user, roles, granted scopes |
| `DELETE /api/me`           | any          | delete your own account |
| `GET /api/terms`           | any          | current terms and your last accepted version |
| `POST /api/terms/accept`   | any          | accept the current terms: `{version}` |
| `GET /api/optional-permissions` | any     | optional permissions and your choice for each |
| `PUT /api/optional-permissions/:id` | any | turn one on or off: `{granted, revision}` |
| `GET /api/sum?a=2&b=8`     | `math-1`     | `10`     |
| `GET /api/multiply?a=2&b=8`| `math-2`     | `16`     |
| `GET /api/power?a=2&b=8`   | `math-3`     | `256`    |
| `GET /api/admin/users`     | `admin`      | users with their group |
| `POST /api/admin/users`    | `admin`      | create user: `{username, email, firstName, lastName, password, group}` |
| `PUT /api/admin/users/:id/group` | `admin` | set group: `{group}` |
| `GET /api/admin/terms`     | `admin`      | every published version of the terms, newest first |
| `POST /api/admin/terms`    | `admin`      | publish a new version: `{title, text}` (plain text) |
| `GET /api/admin/optional-permissions` | `admin` | optional permissions with who is opted in |
| `POST /api/admin/optional-permissions` | `admin` | add one: `{label, description}` |
| `PUT /api/admin/optional-permissions/:id` | `admin` | edit or enable/disable: `{label?, description?, enabled?}` |
| `DELETE /api/admin/optional-permissions/:id` | `admin` | delete one (soft delete) |
| `POST /api/email/send`     | scope `send-email`    | simulated email to the user |
| `GET /api/contacts`        | scope `read-contacts` | fake contact list |

Responses: `401` missing or invalid token, `403` missing role or scope or terms not accepted, `400` invalid input, `404` unknown user,
`409` username or email already taken.

## Seeding Keycloak

`keycloak/seed.mjs` configures the realm through the Keycloak Admin REST API (no dependencies, Node 18+).
It waits for Keycloak, logs in as the master-realm admin, then creates or updates:

- realm `poc` (display name and the `poc` login theme)
- the built-in Terms and Conditions required action, turned off (the app handles the terms)
- client scopes `send-email` and `read-contacts` (shown on the consent screen)
- realm roles `math-1`, `math-2`, `math-3`, `admin`
- groups `basic`, `premium` and `admin` and the roles each one grants
- clients `poc-frontend` (consent required, optional scopes, `poc-backend` audience mapper) and `poc-backend`
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
