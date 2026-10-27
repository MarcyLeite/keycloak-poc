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
  await loadOptional();
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

// --- Optional permissions --------------------------------------------------

// The label and description shown for a permission, in both the user's and the admin's tables.
function permissionCell(p) {
  const cell = document.createElement('td');
  const label = Object.assign(document.createElement('strong'), { textContent: p.label });
  const description = Object.assign(document.createElement('div'), { className: 'hint', textContent: p.description });
  cell.append(label, description);
  return cell;
}

// The current version of the optional permissions and the user's choice for each enabled one
// (see GET /api/optional-permissions). Any admin change publishes a new version and resets every choice.
let optional = null;
let optionalVersion = null;
// "Decide later" skips the review screen for this version until the next page load. Choices stay as they are
// (undecided = off). A new version after that brings the screen back.
let postponedVersion = null;
const optionalReviewPending = () => postponedVersion !== optionalVersion && Boolean(optional?.some((p) => !p.decided));

async function loadOptional() {
  const { ok, body } = await api('/optional-permissions');
  if (ok) ({ permissions: optional, version: optionalVersion } = body);
  else $('optional-status').textContent = `Could not load: ${body.error}`;
}

// Saves one choice for the version the user saw. A 409 means an admin changed the permissions meanwhile:
// reload, so the user sees the new version (and the review screen asks again).
async function saveChoice(p, granted) {
  const res = await api(`/optional-permissions/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { granted, version: optionalVersion } });
  if (res.status === 409) await loadOptional();
  return res;
}

// How it differs from the previous version, so users can see what's new.
const badge = (p) => ({ new: 'New', changed: 'Changed' })[p.change] ?? null;

function withBadge(p) {
  const cell = permissionCell(p);
  if (badge(p)) cell.querySelector('strong').after(Object.assign(document.createElement('span'), { className: 'badge', textContent: badge(p) }));
  return cell;
}

function renderOptionalTable() {
  const rows = (optional ?? []).map((p) => {
    const tr = document.createElement('tr');
    tr.append(withBadge(p));
    const toggle = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.granted });
    toggle.setAttribute('aria-label', p.label);
    toggle.addEventListener('change', async () => {
      const res = await saveChoice(p, toggle.checked);
      if (!res.ok) {
        render();
        return ($('optional-status').textContent = `Error: ${res.body.error}`);
      }
      Object.assign(p, { granted: toggle.checked, decided: true });
      render();
      $('optional-status').textContent = `${p.label}: ${toggle.checked ? 'allowed' : 'not allowed'}`;
    });
    const cell = tr.insertCell();
    cell.append(toggle);
    if (!p.decided) cell.append(' not decided yet');
    return tr;
  });
  $('optional-permissions').replaceChildren(...rows);
}

// Shown after login when the user hasn't chosen in the current version: on first use, and after every admin
// change. It lists every permission, since all choices were reset. Nothing is blocked: the user can decide
// later, and everything they don't allow stays off. Boxes start unticked (only choices already made in this
// version are shown ticked): pre-ticked boxes aren't valid consent.
function renderOptionalReview() {
  const rows = optional.map((p) => {
    const tr = document.createElement('tr');
    tr.append(withBadge(p));
    const toggle = Object.assign(document.createElement('input'), { type: 'checkbox', checked: p.decided && p.granted, name: p.id });
    toggle.setAttribute('aria-label', p.label);
    const label = document.createElement('label');
    label.append(toggle, ' Allow');
    tr.insertCell().append(label);
    return tr;
  });
  $('optional-review-list').replaceChildren(...rows);
}

$('optional-review-save').addEventListener('click', async () => {
  for (const p of optional) {
    const granted = $('optional-review-list').querySelector(`input[name="${CSS.escape(p.id)}"]`).checked;
    const res = await saveChoice(p, granted);
    if (!res.ok) {
      await loadOptional();
      render();
      $('optional-review-error').textContent = `Error: ${res.body.error}`;
      return;
    }
  }
  $('optional-review-error').textContent = '';
  await loadOptional();
  render();
});
$('optional-review-later').addEventListener('click', () => {
  postponedVersion = optionalVersion;
  render();
});

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

const RESET_WARNING = "This publishes a new version: everyone's choices for all optional permissions are reset and every user is asked to review them all again.";

// After an admin change: the admin is a user too, so a new or changed permission asks them again.
async function refreshOptional() {
  await loadOptional();
  render();
}

function editPermission(tr, p) {
  const label = Object.assign(document.createElement('input'), { value: p.label, ariaLabel: 'Name' });
  const description = Object.assign(document.createElement('input'), { value: p.description, ariaLabel: 'Description' });
  const save = Object.assign(document.createElement('button'), { textContent: 'Save' });
  const cancel = Object.assign(document.createElement('button'), { textContent: 'Cancel', className: 'secondary' });
  const fields = Object.assign(document.createElement('div'), { className: 'edit-row' });
  fields.append(label, description, save, cancel);
  const cell = document.createElement('td');
  cell.colSpan = 4;
  cell.append(fields);
  tr.replaceChildren(cell);
  cancel.addEventListener('click', loadOptionalAdmin);
  save.addEventListener('click', async () => {
    if (label.value.trim() === p.label && description.value.trim() === p.description) return loadOptionalAdmin();
    if (!confirm(`Save the new text? ${RESET_WARNING}`)) return;
    const res = await api(`/admin/optional-permissions/${encodeURIComponent(p.id)}`, {
      method: 'PUT', body: { label: label.value, description: description.value },
    });
    $('optional-admin-status').textContent = res.ok ? `Published version ${res.body.version}. Everyone will be asked to review again.` : `Error: ${res.body.error}`;
    refreshOptional();
  });
}

async function loadOptionalAdmin() {
  const { ok, body } = await api('/admin/optional-permissions');
  if (!ok) return ($('optional-admin-status').textContent = `Could not load: ${body.error}`);

  const button = (text, className, onClick) => {
    const b = Object.assign(document.createElement('button'), { textContent: text, className });
    b.addEventListener('click', onClick);
    return b;
  };
  const by = body.publishedBy ? ` by ${body.publishedBy}` : '';
  $('optional-admin-version').textContent = `Current version: ${body.version}, published ${new Date(body.publishedAt).toLocaleString()}${by}.`;
  const rows = body.permissions.map((p) => {
    const tr = document.createElement('tr');
    if (!p.enabled) tr.className = 'disabled';
    tr.append(permissionCell(p));
    tr.insertCell().textContent = p.enabled ? 'Enabled' : 'Disabled';
    tr.insertCell().textContent = p.grantedUsers.length
      ? `${p.grantedUsers.length}: ${p.grantedUsers.map((u) => u.username).join(', ')}`
      : '0';

    const actions = tr.insertCell();
    actions.className = 'actions';
    actions.append(
      button('Edit', '', () => editPermission(tr, p)),
      button(p.enabled ? 'Disable' : 'Enable', 'secondary', async () => {
        if (!confirm(`${p.enabled ? 'Disable' : 'Enable'} "${p.label}"? ${RESET_WARNING}`)) return;
        const res = await api(`/admin/optional-permissions/${encodeURIComponent(p.id)}`, { method: 'PUT', body: { enabled: !p.enabled } });
        $('optional-admin-status').textContent = res.ok ? `${p.label} ${p.enabled ? 'disabled' : 'enabled'}: published version ${res.body.version}.` : `Error: ${res.body.error}`;
        refreshOptional();
      }),
      button('Delete', 'danger', async () => {
        if (!confirm(`Delete "${p.label}"? ${RESET_WARNING}`)) return;
        const res = await api(`/admin/optional-permissions/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        $('optional-admin-status').textContent = res.ok ? `Deleted ${p.label}: published version ${res.body.version}.` : `Error: ${res.body.error}`;
        refreshOptional();
      }),
    );
    return tr;
  });
  $('optional-admin').replaceChildren(...rows);
}

$('add-permission').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  if (!confirm(`Add "${form.label.value}"? ${RESET_WARNING}`)) return;
  const { ok, body } = await api('/admin/optional-permissions', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
  if (!ok) return ($('optional-admin-status').textContent = `Error: ${body.error}`);
  $('optional-admin-status').textContent = `Added ${form.label.value}: published version ${body.version}. Everyone will be asked to review again.`;
  form.reset();
  refreshOptional();
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
  // Terms first (required), then any new or changed optional permissions (skippable), then the app.
  const reviewing = !termsPending() && optionalReviewPending();
  $('optional-review').hidden = !keycloak.authenticated || !reviewing;
  $('logged-in').hidden = !keycloak.authenticated || termsPending() || reviewing;
  if (!keycloak.authenticated) return;
  if (termsPending()) return renderTerms();
  if (reviewing) return renderOptionalReview();

  const claims = keycloak.tokenParsed;
  $('username').textContent = claims.preferred_username;
  const roles = claims.realm_access?.roles ?? [];
  $('roles').textContent = roles.filter((r) => r.startsWith('math-') || r === 'admin').join(', ') || 'none';
  $('claims').textContent = JSON.stringify(claims, null, 2);
  $('terms').textContent = terms
    ? `License terms v${terms.accepted.version} accepted on ${new Date(terms.accepted.time).toLocaleString()}`
    : '';
  renderPermissions();
  renderOptionalTable();

  // Only a UI hint: the backend enforces the admin role on every /api/admin call.
  const isAdmin = roles.includes('admin');
  $('admin').hidden = !isAdmin;
  if (isAdmin) {
    $('create-user').group.replaceChildren(...GROUPS.map((g) => new Option(g, g)));
    loadUsers();
    loadTermsAdmin();
    loadOptionalAdmin();
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
if (keycloak.authenticated) {
  await loadTerms();
  if (!termsPending()) await loadOptional();
}
render();
