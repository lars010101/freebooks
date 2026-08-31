# API Tokens in Settings → Access — Spec

**Status:** PROPOSED
**Scope:** Give `auth.token.create` / `auth.token.list` / `auth.token.revoke` a UI surface on the existing Settings → Access tab. Closes the one hard gap found while retiring the `:` command bar (`:token create`/`:token revoke` currently have no other path — confirmed by grep across every page file and `nav-registry.js`).
**Companion:** `global-search-spec.md` §0.
**Depends on:** `tokens.js` (actions unchanged), `auth.js` (unchanged), `settings.js` (`accessList` FB.list config, existing — extended by adding a second, sibling register on the same tab).

---

## 0. Why this exists, and why it's UI-only

`auth.token.create`/`list`/`revoke` are real, working, `owner`-gated actions (`action-catalog.js`, confirmed) backing per-actor Bearer credentials used for remote/agent API access (`agent-readiness spec §2.6`). Nobody has ever built a page for them — the only way to mint or revoke a token today is the `:token` command-bar alias. Since that's going away (`global-search-spec.md`), this is a pure frontend addition: no backend action changes.

---

## 1. Placement — a second register on Access, not a column on the permissions grid

The existing Access tab (`settings.js`, `accessList`) is one row per `(email, role)` — a permission grant. Tokens are a different entity (`api_tokens`: `token_id`, `label`, `email`, `created_at`, `revoked_at`) with a different cardinality: one email can hold zero, one, or several tokens, entirely independent of its permission row. Folding tokens into the permissions grid as extra columns would conflate two unrelated one-to-many relationships into one row shape — the same category of mismatch already rejected for VAT tolerance-as-a-Tax-Codes-column. Instead: a **second, separate FB.list register**, stacked below the existing permissions grid on the same `tab-access` panel, under its own heading ("API Tokens").

---

## 2. FB.list config

```js
var tokensList = FB.list.create({
  keysId: 'settings-access-tokens',
  active: function() { var p = document.getElementById('tab-access'); return !!(p && p.classList.contains('active')); },
  tbody: 'access-tokens-body',
  companyId: function() { return COMPANY; },
  hint: 'Tokens authenticate remote/agent API callers. The token value is shown once, at creation — copy it immediately. Revoking is permanent; a revoked token cannot be un-revoked, only replaced with a new one.',
  columns: [
    { field: 'label', type: 'text', width: 180, ro: 'saved', label: 'Label' },
    { field: 'email', type: 'text', width: 220, ro: 'saved', label: 'Email' },
    { field: 'created_at', type: 'text', width: 140, ro: 'always', label: 'Created',
      display: function(v) { return v ? new Date(v).toLocaleDateString() : ''; } },
    { field: 'status', type: 'text', width: 100, ro: 'always', filterType: 'list', label: 'Status',
      display: function(v, d) { return d.revoked_at
        ? '<span class="pe-ro">Revoked ' + new Date(d.revoked_at).toLocaleDateString() + '</span>'
        : '<span style="color:#2a7">Active</span>'; } }
  ],
  blank: function() { return { label: '', email: '' }; },
  isBlank: function(b) { return !b.label && !b.email; },
  same: function() { return true; },   // rows are never edited in place, only created or revoked
  validate: function(d) {
    if (!d.label) return 'Label required.';
    if (!d.email) return 'Email required.';
    d.email = d.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'Not a valid email address.';
    return null;
  },
  editable: function() { return false; },      // create-or-revoke only, no in-place edit
  deletable: function(d) { return !d.revoked_at; },  // already-revoked rows aren't deletable again
  firstField: function() { return 'label'; },
  track: 'api-token',
  list: { action: 'auth.token.list',
    map: function(r) {
      return { label: r.label, email: r.email, created_at: r.created_at,
               revoked_at: r.revoked_at, _key: r.token_id };
    } },
  save: { action: 'auth.token.create',
    body: function(d) { return { label: d.label, email: d.email }; },
    focusKey: function(d, res) { return res.tokenId; },
    // §3 — the create response carries the raw token, shown once. onSaved
    // already exists (fb-list.js:1313-1314) and is called with (d, res)
    // after a successful save; it may return a custom status string. The
    // Extensions posting-rules register already uses it (settings.js:410).
    onSaved: function(d, res) { fbRevealToken(res.token); return 'Token created — copy it now, it won’t be shown again.'; } },
  del: { action: 'auth.token.revoke',
    body: function(d) { return { tokenId: d._key }; },
    confirm: function(d) { return 'Revoke token "' + d.label + '" (' + d.email + ')? This cannot be undone.'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-access');
    if (dirty) markDirty('access'); else resetDirty('access');
  }
});
function loadTokens() { tokensList.load(); }
```

Notes tying back to existing conventions:

- **`ro: 'saved'` on `label`/`email`** — same treatment as the permissions grid's `email` column: editable on the new row, locked once saved. A token's identity is fixed at creation; renaming isn't offered, matching `tokens.js`'s own model (revoke + create-new covers it).
- **`editable: false`** — this register has no in-place edit at all, only the two lifecycle transitions `tokens.js` actually supports (mint, revoke). No new framework capability — `editable`/`deletable` gating on a computed condition is the same mechanism FX's read-only ECB rows already use (`fb-list-ux-spec.md` §7).
- **Same `owner`-only gating as the permissions grid** — `action-catalog.js` already marks all three `auth.token.*` actions `role: 'owner'`, matching `permissions.upsert`/`permissions.delete`. No new permission model to build.

---

## 3. The one genuinely new piece: reveal-once

`tokens.js`'s own comment is explicit: *"The token string is shown ONCE at creation; only its sha256 hex is stored."* This is a real UX requirement FB.list's normal save flow doesn't cover — a silent "Saved ✓" status-bar flash (the framework's default) would lose the only copy of the credential the user will ever see.

The closest existing precedent is the FX API Key field's masking convention ("a blank edit keeps the stored key," `settings.js` hint text) — but that's a **write-blind, mask-on-edit** pattern, not a **reveal-once-then-forget** pattern. They solve adjacent but different problems; the FX precedent doesn't cover this case as-is.

No new framework hook is needed. `cfg.save.onSaved(d, res)` already exists (`fb-list.js:1313-1314`, called after a successful save with `(data, response)`, allowed to return a custom status string) and is already in use by the Extensions posting-rules register (`settings.js:410`). `onSaved` calls `fbRevealToken(res.token)` as a side effect — rendering a small dismissible panel directly under the newly-created row: the raw token in a monospace, selectable field, a copy-to-clipboard button, and an explicit "I've saved this" dismiss action, no auto-dismiss — then returns a status string (`'Token created — copy it now, it won't be shown again.'`) for the normal status-bar slot. Two effects from one hook, no new plumbing.

---

## 4. Explicitly open

- **Free-text email vs. constrained to existing Access grants** — `tokens.js` allows minting a token for any email, regardless of whether that email holds a permission row on the grid above it. Worth deciding whether the UI should constrain the token form to emails already present in the permissions register (avoiding orphaned tokens for accounts with no granted role) or allow ad-hoc entry as the backend does today. Not resolved here.
