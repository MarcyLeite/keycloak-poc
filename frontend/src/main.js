import Keycloak from 'keycloak-js';

// Everything is served from one origin through nginx, so relative URLs work.
const API_URL = '/api';

const keycloak = new Keycloak({
  url: `${window.location.origin}/auth`,
  realm: 'poc',
  clientId: 'poc-frontend',
});

const $ = (id) => document.getElementById(id);

const GROUPS = ['basic', 'premium', 'admin'];

// Permissions the app can ask for. `optional` ones are requested on demand, the rest at login.
const PERMISSIONS = [
  { scope: 'email', label: 'Read your email address' },
  { scope: 'profile', label: 'Read your profile (name, username)' },
  { scope: 'send-email', label: 'Send emails on your behalf', optional: true, demo: { label: 'Send test email', method: 'POST', path: '/email/send' } },
  { scope: 'read-contacts', label: 'Read your contacts', optional: true, demo: { label: 'Load contacts', path: '/contacts' } },
];

// Optional scopes the user already granted. Keycloak only puts an optional scope in the token when the
// app asks for it, so they are sent again on every login and silent SSO check.
const SCOPES_KEY = 'poc.scopes';
const savedScopes = () => {
  try {
    return JSON.parse(localStorage.getItem(SCOPES_KEY)) ?? [];
  } catch {
    return [];
  }
};
const saveScopes = (scopes) => {
  try {
    localStorage.setItem(SCOPES_KEY, JSON.stringify(scopes));
  } catch {
    // storage unavailable: optional scopes will be asked for again
  }
};
const scopeParam = (scopes) => ['openid', ...scopes].join(' ');

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
  const result = { status: res.status, ok: res.ok, body: await res.json() };
  // New terms were published while the user was in the app: ask for them now.
  if (res.status === 403 && result.body.code === 'terms_not_accepted') loadTerms().then(render);
  return result;
}

// --- License terms ---------------------------------------------------------

// { current: {version, publishedAt, title, html}, accepted: {version, time} | null }, from the backend.
let terms = null;
const termsPending = () => terms && terms.accepted?.version !== terms.current.version;

async function loadTerms() {
  const { ok, body } = await api('/terms');
  if (ok) terms = body;
}

function renderTerms() {
  const { title, version, publishedAt, html } = terms.current;
  $('terms-title').textContent = title;
  $('terms-version').textContent = `Version ${version}, published ${new Date(publishedAt).toLocaleDateString()}`
    + (terms.accepted ? ` · You accepted version ${terms.accepted.version} before; the terms have changed.` : '');
  // The HTML comes from our own backend/terms.json, not from users.
  $('terms-text').innerHTML = html;
  $('terms-error').textContent = '';
}

$('terms-accept').addEventListener('click', async () => {
  const { ok, body } = await api('/terms/accept', { method: 'POST', body: { version: terms.current.version } });
  if (!ok) {
    // 409: a newer version was published while the screen was open. Show that one instead.
    await loadTerms();
    render();
    $('terms-error').textContent = `Error: ${body.error}`;
    return;
  }
  terms.accepted = body;
  render();
});
$('terms-decline').addEventListener('click', () => keycloak.logout({ redirectUri: window.location.origin }));

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

// --- Permissions -----------------------------------------------------------

// Redirects to Keycloak, which shows the consent screen for the new scope, then comes back.
function requestScope(scope) {
  const scopes = [...new Set([...savedScopes(), scope])];
  saveScopes(scopes);
  keycloak.login({ scope: scopeParam(scopes) });
}

function renderPermissions() {
  const granted = keycloak.tokenParsed.scope?.split(' ') ?? [];
  const rows = PERMISSIONS.map((p) => {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = p.label;
    tr.insertCell().append(Object.assign(document.createElement('code'), { textContent: p.scope }));
    const isGranted = granted.includes(p.scope);
    const status = tr.insertCell();
    if (isGranted) {
      status.textContent = '✅ granted';
    } else {
      const allow = Object.assign(document.createElement('button'), { textContent: 'Allow…' });
      allow.addEventListener('click', () => requestScope(p.scope));
      status.append(allow);
    }
    const demoCell = tr.insertCell();
    if (p.demo) {
      // Enabled even without the scope, to show the backend answering 403.
      const btn = Object.assign(document.createElement('button'), { textContent: p.demo.label });
      btn.addEventListener('click', async () => {
        const { status, body } = await api(p.demo.path, { method: p.demo.method });
        $('permission-result').textContent = `HTTP ${status}\n${JSON.stringify(body, null, 2)}`;
      });
      demoCell.append(btn);
    }
    return tr;
  });
  $('permissions').replaceChildren(...rows);
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

      const accepted = u.termsAccepted;
      tr.insertCell().textContent = accepted?.version === terms?.current.version
        ? `✅ v${accepted.version}`
        : `⏳ pending${accepted ? ` (accepted v${accepted.version})` : ''}`;
      tr.insertCell().textContent = u.grantedScopes ? u.grantedScopes.join(', ') : '— (never consented)';
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

// Plain text for the publish form: one paragraph per <p>, blank lines between them.
// DOMParser never runs scripts, and the text only goes into a textarea.
function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('br').forEach((br) => br.replaceWith('\n'));
  const paragraphs = [...doc.body.querySelectorAll('p')].map((p) => p.textContent.trim());
  return paragraphs.length ? paragraphs.join('\n\n') : doc.body.textContent.trim();
}

async function loadTermsAdmin() {
  const { ok, body } = await api('/admin/terms');
  if (!ok) return ($('terms-admin-status').textContent = `Could not load terms: ${body.error}`);

  // Start from the current version, so the admin edits it rather than retyping it.
  const [latest] = body;
  const form = $('publish-terms');
  form.title.value = latest.title;
  form.text.value = htmlToText(latest.html);
  $('publish-terms-button').textContent = `Publish as version ${latest.version + 1}`;

  const rows = body.map((t) => {
    const tr = document.createElement('tr');
    tr.insertCell().textContent = `v${t.version}${t.version === latest.version ? ' (current)' : ''}`;
    tr.insertCell().textContent = new Date(t.publishedAt).toLocaleString();
    tr.insertCell().textContent = t.publishedBy ?? '—';
    const details = document.createElement('details');
    const summary = Object.assign(document.createElement('summary'), { textContent: t.title });
    // Same HTML every user sees on the terms screen; the backend escapes what admins publish.
    const text = Object.assign(document.createElement('div'), { className: 'terms-text', innerHTML: t.html });
    details.append(summary, text);
    tr.insertCell().append(details);
    return tr;
  });
  $('terms-versions').replaceChildren(...rows);
}

$('publish-terms').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(e.currentTarget));
  if (!confirm('Publish these terms as a new version? Every user, you included, must accept them again.')) return;
  const { ok, body } = await api('/admin/terms', { method: 'POST', body: data });
  if (!ok) return ($('terms-admin-status').textContent = `Error: ${body.error}`);
  // The admin hasn't accepted the new version either, so this shows them the terms screen.
  await loadTerms();
  render();
});

// ---------------------------------------------------------------------------

function render() {
  $('logged-out').hidden = keycloak.authenticated;
  $('terms-screen').hidden = !keycloak.authenticated || !termsPending();
  $('logged-in').hidden = !keycloak.authenticated || termsPending();
  if (!keycloak.authenticated) return;
  if (termsPending()) return renderTerms();

  const claims = keycloak.tokenParsed;
  $('username').textContent = claims.preferred_username;
  const roles = claims.realm_access?.roles ?? [];
  $('roles').textContent = roles.filter((r) => r.startsWith('math-') || r === 'admin').join(', ') || 'none';
  $('claims').textContent = JSON.stringify(claims, null, 2);
  $('terms').textContent = terms
    ? `License terms v${terms.accepted.version} accepted on ${new Date(terms.accepted.time).toLocaleString()}`
    : '';
  renderPermissions();

  // Only a UI hint: the backend enforces the admin role on every /api/admin call.
  const isAdmin = roles.includes('admin');
  $('admin').hidden = !isAdmin;
  if (isAdmin) {
    $('create-user').group.replaceChildren(...GROUPS.map((g) => new Option(g, g)));
    loadUsers();
    loadTermsAdmin();
  }
}

$('delete-account').addEventListener('click', async () => {
  if (!confirm(`Delete the account "${keycloak.tokenParsed.preferred_username}"? This can't be undone.`)) return;
  const { ok, body } = await api('/me', { method: 'DELETE' });
  if (!ok) return ($('delete-status').textContent = `Error: ${body.error}`);
  // The Keycloak session was deleted with the user, so only the local tokens are left to drop.
  keycloak.clearToken();
  saveScopes([]);
  render();
  $('login-error').textContent = 'Your account was deleted.';
});
$('login').addEventListener('click', () => keycloak.login({ scope: scopeParam(savedScopes()) }));
$('account').addEventListener('click', () => keycloak.accountManagement());
$('logout').addEventListener('click', () => keycloak.logout({ redirectUri: window.location.origin }));
document.querySelectorAll('[data-op]').forEach((btn) => btn.addEventListener('click', () => callApi(btn.dataset.op)));

keycloak.onTokenExpired = () => keycloak.updateToken(30).catch(() => keycloak.login());

try {
  await keycloak.init({
    onLoad: 'check-sso',
    pkceMethod: 'S256',
    checkLoginIframe: false,
    scope: scopeParam(savedScopes()),
  });
} catch (err) {
  // The user clicked "No" on the consent screen. Forget the optional scopes and start over;
  // their Keycloak session is still alive, so the reload logs them back in without them.
  if (err?.error === 'access_denied' && savedScopes().length) {
    saveScopes([]);
    window.location.replace(window.location.pathname);
  }
  if (err?.error === 'access_denied') {
    $('login-error').textContent = 'Login cancelled: the requested permissions were declined.';
  }
  console.error('Keycloak init failed', err);
}
if (keycloak.authenticated) await loadTerms();
render();
