import Keycloak from 'keycloak-js';

const API_URL = 'http://localhost:3000/api';

const keycloak = new Keycloak({
  url: 'http://localhost:8080',
  realm: 'poc',
  clientId: 'poc-frontend',
});

const $ = (id) => document.getElementById(id);

const GROUPS = ['basic', 'premium', 'admin'];

async function api(path, { method = 'GET', body } = {}) {
  await keycloak.updateToken(30); // refresh if it expires within 30s
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${keycloak.token}`,
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, ok: res.ok, body: await res.json() };
}

async function callApi(op) {
  const a = encodeURIComponent($('a').value);
  const b = encodeURIComponent($('b').value);
  try {
    const { status, body } = await api(`/${op}?a=${a}&b=${b}`);
    $('result').textContent = `HTTP ${status}\n${JSON.stringify(body, null, 2)}`;
  } catch (err) {
    $('result').textContent = `Error: ${err?.message ?? err}`;
  }
}

// --- Admin -----------------------------------------------------------------

const setAdminStatus = (text) => ($('admin-status').textContent = text);

function groupSelect(selected) {
  const select = document.createElement('select');
  if (!selected) select.append(new Option('(none)', '', true, true));
  for (const g of GROUPS) select.append(new Option(g, g, false, g === selected));
  return select;
}

async function loadUsers() {
  const { ok, body } = await api('/admin/users');
  if (!ok) return setAdminStatus(`Could not load users: ${body.error}`);

  // Built with DOM APIs (not innerHTML) so user-supplied values can't inject markup.
  const rows = body
    .sort((x, y) => x.username.localeCompare(y.username))
    .map((u) => {
      const tr = document.createElement('tr');
      for (const text of [u.username, `${u.firstName ?? ''} ${u.lastName ?? ''}`.trim(), u.email ?? '']) {
        tr.insertCell().textContent = text;
      }
      const select = groupSelect(u.group);
      select.addEventListener('change', async () => {
        const res = await api(`/admin/users/${u.id}/group`, { method: 'PUT', body: { group: select.value } });
        setAdminStatus(res.ok ? `${u.username} moved to ${select.value}` : `Error: ${res.body.error}`);
        if (!res.ok) loadUsers();
      });
      tr.insertCell().append(select);
      return tr;
    });
  $('users').replaceChildren(...rows);
}

$('create-user').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const { ok, body } = await api('/admin/users', { method: 'POST', body: data });
  if (!ok) return setAdminStatus(`Error: ${body.error}`);
  setAdminStatus(`Created ${body.username} in ${body.group}`);
  form.reset();
  loadUsers();
});

// ---------------------------------------------------------------------------

function render() {
  $('logged-in').hidden = !keycloak.authenticated;
  $('logged-out').hidden = keycloak.authenticated;
  if (!keycloak.authenticated) return;

  const claims = keycloak.tokenParsed;
  $('username').textContent = claims.preferred_username;
  const roles = claims.realm_access?.roles ?? [];
  $('roles').textContent = roles.filter((r) => r.startsWith('math-') || r === 'admin').join(', ') || 'none';
  $('claims').textContent = JSON.stringify(claims, null, 2);

  // Only a UI hint: the backend enforces the admin role on every /api/admin call.
  const isAdmin = roles.includes('admin');
  $('admin').hidden = !isAdmin;
  if (isAdmin) {
    $('create-user').group.replaceChildren(...GROUPS.map((g) => new Option(g, g)));
    loadUsers();
  }
}

$('login').addEventListener('click', () => keycloak.login());
$('logout').addEventListener('click', () => keycloak.logout({ redirectUri: window.location.origin }));
document.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => callApi(btn.dataset.op)));

keycloak.onTokenExpired = () => keycloak.updateToken(30).catch(() => keycloak.login());

await keycloak.init({
  onLoad: 'check-sso',
  pkceMethod: 'S256',
  checkLoginIframe: false,
});
render();
