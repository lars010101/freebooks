# Admin → Access Tab — Spec (Option B, full scope)

**Status:** PROPOSED
**Scope:** New Admin tab (Companies · Operations · **Access**) for full CRUD over `user_permissions`; two new per-row server actions (`permissions.upsert`, `permissions.delete`); guardrails against lockout; small AI-tab tie-in.
**Companions:** `fb-list-ux-spec.md` (the machine this tab runs on), `settings-ux-spec.md` §7 item 1 (origin of the "no admin page yet" note), `ia-restructure-spec.md` §3.4/§5.2 (Admin section shape; Centers precedent for retiring bulk-save actions), `settings-ai-flattened-spec.md` (open question #2, partially closed here), `agent-setup-guide.md` (the SQL workaround this tab replaces)
**Consumers:** `api/src/index.js` (`handlePermissions`), `api/src/action-catalog.js`, `api/src/pages/admin-page.js`, `api/src/pages/settings.js` (AI tab, minor)

---

## 0. Placement: Admin, not Settings

The ticket frames this as "a new Settings tab," but the codebase has already ruled on where this lands. `settings-ux-spec.md` §7 item 1 explicitly deferred *"user/permission management"* to a future admin surface, and `ia-restructure-spec.md` (RATIFIED 2026-08-11) built that surface — **Admin** (`/:company/admin`) — and named user/role permission management as one of its parked, not-yet-built occupants (§3.4). Settings was deliberately slimmed to Company · Posting Rules · AI in the same restructure.

So this spec adds **Access** as a third Admin tab: `Companies · Operations · Access`. Everything below is written against that placement. The tab itself (columns, FB.list config, guardrails) is portable to Settings if that's overruled — only the tab-strip wiring in `admin-page.js` vs `settings.js` changes.

---

## 1. What's actually missing (confirmed in code)

- `permissions.list` / `permissions.save` exist and work (`api/src/index.js` `handlePermissions`), owner-role gated.
- No screen calls either. `admin-page.js` today has only `Companies` (browse/switch) and `Operations` (a card grid, currently just a disabled "Test LLM Connection" placeholder).
- The `permissions.save` palette entry is a stale placeholder — it currently routes `:`/Ctrl+K to `/settings?tab=company`, which has nothing to do with permissions. This gets fixed as part of this work (§6).
- `permissions.save` is a **bulk delete-all-and-reinsert** — the same shape Cost/Profit Centers had before its FB.list tab was built. `ia-restructure-spec.md` §5.2 already retired that pattern for Centers in favor of per-row `upsert`/`delete`, "the same 'replace everything' pattern already retired for VAT codes and FX rates in favor of the one-save-path-per-row (`w`) doctrine." Access should get the same treatment, not become the one list in the app still wired to a bulk endpoint — see §2 for why this isn't just style consistency, it's also a correctness fix.
- No test in `api/test/*.test.js` calls `permissions.save` at all today. Test setup uses raw `INSERT INTO user_permissions` SQL exclusively. New coverage is needed either way (§8).

---

## 2. API changes

### 2.1 Add `permissions.upsert` and `permissions.delete`

```js
'permissions.upsert': { role: 'owner', mutating: true,
  description: 'Insert or update one user_permissions row (email, role) for the current company.',
  params: { email: { type: 'string', required: true }, role: { type: 'string', required: true } } },
'permissions.delete': { role: 'owner', mutating: true,
  description: 'Revoke one user\u2019s permission on the current company.',
  params: { email: { type: 'string', required: true } } },
```

Server (`handlePermissions`, same style as `center.upsert`/`center.delete`):

```js
const { ROLE_HIERARCHY } = require('./auth'); // single source of truth for valid roles — don't
                                               // re-list them here; a role added to auth.js later
                                               // would otherwise get silently rejected as unknown
const ROLES = Object.keys(ROLE_HIERARCHY);

if (action === 'permissions.upsert') {
  let { email, role } = body;
  if (!email) throw Object.assign(new Error('email required'), { code: 'INVALID_INPUT' });
  if (!ROLES.includes(role)) throw Object.assign(new Error(`role must be one of ${ROLES.join(', ')}`), { code: 'INVALID_INPUT' });
  email = email.toLowerCase(); // normalize BEFORE the DELETE match — DuckDB string comparison
                                // is case-sensitive; without this, upserting "Agent@x.com" then
                                // "agent@x.com" misses the existing row and creates a silent
                                // duplicate instead of updating it (see \u00a72.4a)

  await assertNotLastOwner(companyId, { excludeEmail: email, newRole: role }); // \u00a72.3

  const now = new Date().toISOString();
  await exec(`DELETE FROM user_permissions WHERE company_id = @companyId AND email = @email`, { companyId, email });
  await bulkInsert('user_permissions', [{ email, company_id: companyId, role, granted_at: now, granted_by: userEmail || null }]);
  return { saved: 1 };
}

if (action === 'permissions.delete') {
  let { email } = body;
  if (!email) throw Object.assign(new Error('email required'), { code: 'INVALID_INPUT' });
  email = email.toLowerCase(); // same normalization, same reason — an exact-match delete on
                                // mismatched casing would silently no-op and leave the row behind
  await assertNotLastOwner(companyId, { excludeEmail: email, newRole: null }); // \u00a72.3
  await exec(`DELETE FROM user_permissions WHERE company_id = @companyId AND email = @email`, { companyId, email });
  return { deleted: 1 };
}
```

`email` is the natural key (scoped to `company_id`), exactly like `period_name` on Periods or `journal code` on Journals — delete-then-insert on write, no dependence on a DB unique constraint (the schema has none: `db/schema.sql` `user_permissions` has no `PRIMARY KEY`/`UNIQUE`, so today it's structurally possible to have two rows for the same email+company; the upsert path closes that off going forward without a migration).

Importing `ROLE_HIERARCHY` from `auth.js` rather than re-declaring the role list here is deliberate: it's already the single source of truth the permission checker itself uses (`checkPermission`/`resolveActor`). Duplicating it as a literal array in the handler would work today but silently drift the moment a role is added to `auth.js` — the Access tab would then reject the new role with "role must be one of…" for no diagnosable reason.

### 2.1a Email case sensitivity (client side)

The server-side normalization above is the actual fix, but it should be mirrored client-side so the grid doesn't render two rows that look identical-but-different while a save is in flight. In the FB.list config's `validate()` (§3.2):

```js
validate: function(d) {
  if (!d.email) return 'Email required.';
  d.email = d.email.trim().toLowerCase(); // normalize the buffer itself, not just a copy —
                                           // so display(), same(), and the save body all agree
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'Not a valid email address.';
  return null;
}
```

Without this, `permissions.list`'s `map()` would show both the old-cased and newly-normalized row side by side until the next full reload, and `same(b, s)` (`b.email === s.email`) would (correctly, but confusingly) treat them as two different people rather than recognizing the edit as a correction.

### 2.2 Keep `permissions.list`; retire or keep `permissions.save`

`permissions.list` is unchanged — it already returns exactly what the tab needs, including `company_id = '*'` rows (§2.4). Per the Centers precedent (§5.2 of `ia-restructure-spec.md`, "implementer's call"), `permissions.save` can stay as-is for scripts/tests that already assume bulk replace, or be retired. Nothing else in the codebase calls it (grep confirms it's not exercised by any test or agent code path today), so removing it is low-risk — but there's no urgency either.

### 2.3 Guardrail: never remove the last owner

Nothing today stops an owner from wiping their own access — `permissions.save` blindly replaces every row. This is the exact failure mode that produced the "stuck, only way out is a SQL insert" problem in the first place, except self-inflicted instead of a missing agent account. Mirror the existing `company.delete` "last remaining company" guard (`api/src/index.js`, `INVALID_STATE`):

```js
async function assertNotLastOwner(companyId, { excludeEmail, newRole }) {
  if (newRole === 'owner') return; // still an owner after the write, trivially fine
  const rows = await query(
    `SELECT 1 FROM user_permissions
     WHERE (company_id = @companyId OR company_id = '*') AND role = 'owner' AND email != @excludeEmail
     LIMIT 1`,
    { companyId, excludeEmail }
  );
  if (rows.length === 0) {
    throw Object.assign(new Error(`Cannot remove the last owner of "${companyId}". Grant another owner first.`), { code: 'INVALID_STATE' });
  }
}
```

Counting `company_id = '*'` owners too is deliberate: if a global owner grant exists, demoting/removing the one company-scoped owner row doesn't actually strand the company. This check is identity-agnostic by necessity — see §7 on why "can't remove *yourself*" isn't buildable today.

### 2.4 The `company_id = '*'` wildcard rows

`permissions.list` already unions in `company_id = '*'` rows (cross-company/global grants — `auth.js`'s `checkPermission`/`resolveActor` treat them as valid for any company). This is exactly why the per-row actions in §2.1 are worth adding rather than reusing bulk `permissions.save`: `permissions.upsert`/`permissions.delete` are scoped to `company_id = @companyId` by construction, so they can never touch or duplicate a `'*'` row. Reusing bulk save would have required the client to carefully exclude `'*'` rows from every outbound payload — miss that once and a global grant silently gets cloned into a company-scoped row with the same email (two rows, confusing precedence, and the original global row is untouched so it looks like a no-op that actually mutated data).

The tab still needs to *display* `'*'` rows for transparency (someone with global access won't otherwise appear anywhere), just not let this tab edit or delete them:
- Rendered read-only, tagged e.g. **"Global"** instead of showing Save/Revert/Delete controls.
- Excluded from `permissions.upsert`/`permissions.delete` entirely (server already can't touch them; client shouldn't offer to).
- No UI exists yet to manage `'*'` grants themselves — that's the genuinely install-level slice `settings-ux-spec.md` §7 deferred (audit viewer, cross-company grants). Out of scope here; noted in §9.

### 2.5 `agent-loop.js` doesn't see `'*'`-scoped agent accounts

Unrelated pre-existing gap, surfaced while reading this code: `getAgentAccount()` in `agent-loop.js` queries `WHERE company_id = @cid AND role = 'agent'` — no `OR company_id = '*'`, unlike every other permission check in the file. A global agent grant would show up correctly in the new Access tab but the poller would still report "no agent-role account" and skip the company. Flagging so it isn't silently inherited as a "the UI must be wrong" bug report later; fixing it is a one-line, unrelated change (§9).

Not a blocker for this spec's actual value, though: `permissions.upsert` writes `company_id = @companyId` rows (§2.1), so the Access tab's own agent-grant flow (the pain point from the original ticket) is unaffected either way — this gap only bites the separate, no-UI-today path of a `'*'`-scoped agent grant.

### 2.6 Multiple `agent`-role rows — pipeline identity must be explicit, not picked

The Access tab makes it trivial to grant the `agent` role to more than one email (e.g. one account for the built-in pipeline, another for an MCP integration — both legitimate). `getAgentAccount()`'s `SELECT email ... WHERE role = 'agent' LIMIT 1` has no `ORDER BY`, so with 2+ candidates the "winner" is whatever DuckDB happens to return — undefined today, and liable to shift further once `permissions.upsert`'s delete-then-insert (§2.1) starts reordering rows on unrelated edits.

A deterministic tiebreak (`ORDER BY granted_at ASC`) would remove the *nondeterminism* but not the actual problem: it would still silently pick one of several agent accounts with no visibility into which, or why, and no way to change the choice short of revoking the "wrong" one's agent role entirely — which may be needed for its own integration. That's not a fix, just a quieter version of the same bug. The real fix is to stop inferring the pipeline's identity from "any row that happens to have the agent role" and make it an explicit, single-valued setting instead:

- **New setting**, same shape as every other AI-tab key (`settings` table, per-company): `agent_pipeline_email`.
- **`ai.attr.list`** gains a `Choice`-type row, same pattern already used for FX Provider / Default Accounts (single-holder select sourced from live data, not a hardcoded list):
  ```js
  { key: 'agent_pipeline_email', label: 'Pipeline agent account', type: 'Choice',
    value: s.agent_pipeline_email || '', display: s.agent_pipeline_email || dash,
    editor: { type: 'select', nullable: true,
      options: await query(
        `SELECT DISTINCT email FROM user_permissions
         WHERE (company_id = @companyId OR company_id = '*') AND role = 'agent'
         ORDER BY email`, { companyId }
      ).then(rows => rows.map(r => r.email)) } }
  ```
  Empty/`- none -` is a valid selection (zero agent accounts, or "not configured yet") — the poller's existing "no agent-role account — skipping" warning already covers that state.
- **`ai.attr.save`** validates the chosen email still holds the `agent` role for this company (or `'*'`) at save time, same server-authoritative posture as every other AI-tab field: reject with `INVALID_INPUT` — *"X does not have the agent role — grant it in Admin → Access first"* — rather than silently accepting a stale choice.
- **`getAgentAccount()` becomes:**
  ```js
  async function getAgentAccount(companyId) {
    const s = await getCompanySettings(companyId);
    if (s.agent_pipeline_email) {
      const [row] = await query(
        `SELECT 1 FROM user_permissions
         WHERE (company_id = @cid OR company_id = '*') AND role = 'agent' AND email = @email LIMIT 1`,
        { cid: companyId, email: s.agent_pipeline_email }
      );
      if (row) return s.agent_pipeline_email;
      warn(`company ${companyId}: configured agent_pipeline_email (${s.agent_pipeline_email}) no longer has the agent role`);
      return null; // fail closed, don't fall back to guessing among the rest
    }
    // Not configured: the common zero-setup case is exactly one agent-role account —
    // keep that working with no config needed. 0 or 2+ candidates without an explicit
    // choice is refused rather than guessed at.
    const candidates = await query(
      `SELECT DISTINCT email FROM user_permissions
       WHERE (company_id = @cid OR company_id = '*') AND role = 'agent'`, { cid: companyId }
    );
    if (candidates.length === 1) return candidates[0].email;
    if (candidates.length > 1) warn(`company ${companyId}: ${candidates.length} agent-role accounts and no agent_pipeline_email configured — set one in Settings \u2192 AI`);
    return null;
  }
  ```

This keeps zero-config installs working exactly as today (one agent account → just works), turns the ambiguous case into a clear, actionable warning instead of a silent wrong guess, and once configured makes the pipeline's identity a visible setting instead of an emergent property of row order. It also folds the §2.5 gap into the same query (`OR company_id = '*'` is already present above), so implementing this supersedes fixing §2.5 separately rather than duplicating the work.

---

## 3. UI — Access tab

### 3.1 Tab shell (`admin-page.js`)

```html
<div class="tabs">
  <div class="tab active" onclick="showTab('companies')">Companies</div>
  <div class="tab" onclick="showTab('operations')">Operations</div>
  <div class="tab" onclick="showTab('access')">Access<span id="tab-dot-access" style="display:none;color:#d97706"> \u25cf</span></div>
</div>
...
<div id="tab-access" class="tab-panel">
  <table class="edit-table" id="access-table">
    <thead><tr><th>Email</th><th>Role</th><th></th><th></th></tr></thead>
    <tbody id="access-body"></tbody>
  </table>
</div>
```

`tabs = ['companies','operations','access']` in `showTab`; wire `loadAccess()` on first activation, same lazy-load pattern as the other two tabs.

### 3.2 FB.list config

Full CRUD register (add row + per-row save/delete), not an attribute/value grid — this is a real list of records with a natural add/remove lifecycle, like Vendors or Periods, not fixed configuration rows like Company/AI/Posting Rules.

```js
var accessList = FB.list.create({
  keysId: 'admin-access',
  active: function() { var p = document.getElementById('tab-access'); return !!(p && p.classList.contains('active')); },
  tbody: 'access-body',
  companyId: function() { return COMPANY; },
  hint: 'Email is the key \u2014 to change a person\u2019s email, remove the row and add a new one. Role changes edit in place. Rows marked Global come from a cross-company grant and can\u2019t be edited here.',
  columns: [
    { field: 'email', type: 'text', width: 240, ro: 'saved', label: 'Email' },
    { field: 'role', type: 'select', width: 130, label: 'Role', filterType: 'list',
      options: [
        { value: 'owner', label: 'Owner' },
        { value: 'data_entry', label: 'Data Entry' },
        { value: 'agent', label: 'Agent' },
        { value: 'viewer', label: 'Viewer' }
      ] },
    { field: 'scope_badge', type: 'text', width: 70, ro: 'always', filterType: null,
      display: function(v, d) { return d.isGlobal ? '<span class="type-badge" style="background:#eef;color:#446">Global</span>' : ''; } }
  ],
  blank: function() { return { email: '', role: 'viewer' }; },
  isBlank: function(b) { return !b.email; },
  same: function(b, s) { return b.email === s.email && b.role === s.role; },
  validate: function(d) {
    if (!d.email) return 'Email required.';
    d.email = d.email.trim().toLowerCase(); // \u00a72.1a \u2014 normalize before same()/save() see it
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return 'Not a valid email address.';
    return null; // role membership + last-owner guard are server-authoritative (\u00a72.1/\u00a72.3)
  },
  editable: function(d) { return !d.isGlobal; },
  deletable: function(d) { return !d.isGlobal; },
  firstField: function() { return 'email'; },
  track: 'access-grant',
  list: { action: 'permissions.list',
    map: function(r) {
      return { email: r.email, role: r.role, isGlobal: r.company_id === '*', _key: r.email };
    } },
  save: { action: 'permissions.upsert',
    body: function(d) { return { email: d.email, role: d.role }; },
    focusKey: function(d) { return d.email; } },
  del: { action: 'permissions.delete',
    body: function(d) { return { email: d.email }; },
    confirm: function(d) { return 'Revoke access for "' + d.email + '"?'; } },
  onChrome: function(dirty) {
    var dot = document.getElementById('tab-dot-access');
    if (dot) dot.style.display = dirty ? '' : 'none';
  }
});
function loadAccess() { accessList.load(); }
```

Notes on the config, tying back to conventions established elsewhere in the app:

- **`email` as the key, `ro: 'saved'`** — same treatment as Periods' `period_name`: editable on a new row, locked once saved. Renaming an email in place would otherwise be ambiguous between "typo fix" and "revoke old, grant new," so it's not offered; delete + re-add covers both.
- **Role is a `select`, not free text** — matches the FX Provider / Default-Accounts pattern elsewhere in Settings (Choice type, `filterType: 'list'` gives a free column filter for "show me all agents/owners").
- **`editable`/`deletable` gate on `isGlobal`** — the mechanism `fb-list-ux-spec.md` §7 already defines for FX's read-only ECB rows; reused as-is, no new framework capability needed.
- **Client `validate()` only checks email shape** — role legitimacy and the last-owner guard are server-authoritative, consistent with the explicit "these are highly sensitive settings; front-end checks are advisory only" stance already applied to Company/Posting Rules/AI.
- **No `rowVerbs`/`extraBindings` needed** — this is a plain register; the standard `j/k/i/Enter/x/w/u` verb table (`fb-list-ux-spec.md` §4) covers everything.

### 3.3 Self-service failure mode

If the last-owner guard (§2.3) rejects a write, the row's `w` fails and the row stays dirty (same behavior every other validated register already has — "server errors keep the row dirty with inputs' values intact," `settings-ux-spec.md` §6). The error string surfaces through the one status channel (`FB.status.show`), e.g. *"Cannot remove the last owner of 'mycompany'. Grant another owner first."* No special-case modal needed.

---

## 4. Closing the actual pain point (the AI tab)

The original bug report's flow was: enable the agent pipeline → agent loop finds no `agent`-role account → stuck. With this tab, the fix is real (Admin → Access → add row, email + `Agent` role, `w`) instead of a SQL escape hatch. Two connective changes on the AI tab make that discoverable and, once more than one agent account exists, actually necessary:

1. **"Pipeline agent account" row (§2.6)** — the `agent_pipeline_email` picker. In the common single-agent-account case it's optional (the zero-config fallback in §2.6 just works); the moment a second `agent`-role account exists anywhere reachable by this company, it stops being optional — `getAgentAccount()` refuses to guess and the pipeline sits idle with a log warning until someone picks one here. So this isn't additive polish sitting alongside the Access tab; it's the piece that keeps the pipeline runnable once Access makes multiple agent accounts easy to create. Empty state when zero agent accounts exist at all: *"No agent account configured yet — [Admin → Access](/:company/admin?tab=access)."*
2. **`settings-ai-flattened-spec.md` open question #2** ("where does Agent status surface once it's off this tab") is now more fully answered: the *account* half of agent status is this row — which email is configured, and (via §2.6's save-time validation) whether it's actually a valid agent account right now. The *runtime* half (is the loop actually running, last poll time) stays a separate, still-open concern for Admin → Operations or a dashboard, unchanged by this spec.

Sequencing note: §2.6 (the setting + picker) should ship in the same pass as the Access tab, not as a follow-up — Access is what makes a second agent account trivial to create, so shipping one without the other reopens a silent-failure window the moment someone adds a second agent grant for an unrelated integration (e.g. an MCP client) without realizing it now shadows the built-in pipeline's account resolution.

---

## 5. Roles shown

All four roles from `auth.js`'s `ROLE_HIERARCHY` are selectable: `owner` (3), `data_entry` (2), `agent` (1.5), `viewer` (1). No role is hidden or specially gated in the picker — an owner can grant any role to anyone, including creating additional owners or multiple agent accounts. Multiple agent accounts are a legitimate pattern (one per integration — the built-in pipeline, an MCP client, etc.), not just tolerated: see §2.6 for how the built-in pipeline picks *which* one is its own identity once more than one exists.

---

## 6. Palette / navigation fixes

- `'permissions.save'` palette entry currently routes to `/settings?tab=company` (a leftover placeholder). Repoint it to Access:

  ```js
  'permissions.upsert': { palette: 'navigate', route: '/admin?tab=access&new=1', label: 'Grant access', create: true },
  'permissions.list':   { palette: 'navigate', route: '/admin?tab=access', label: 'Access' },
  // 'permissions.save' entry removed if the action itself is retired (\u00a72.2); otherwise repoint identically.
  ```

- No `nav-registry.js` changes needed — Admin already has its `g a` entry; this is a same-page tab, reached the same way Settings' Company/Posting Rules/AI tabs are (in-page `showTab`, no new top-level route).
- `?tab=access` deep-link handling in `admin-page.js`'s existing `URLSearchParams` block, same one-liner as `companies`/`operations`.

---

## 7. A note on identity (why "can't remove yourself" isn't in scope)

Worth surfacing because it shapes what's actually buildable here: in the default (`trust`) auth mode the *browser* UI never sends `userEmail` in `/api/action` bodies at all (confirmed — nothing in `api/public/*.js` sets it). `handleApiRequest` only runs `checkPermission` when `userEmail` is truthy, so ordinary browser/loopback use today is **not identity-checked** — the owner-only gate on `permissions.*` is real for Bearer-token callers (agents, `token-remote` mode) but not for the primary human-facing UI, which trusts anyone who can reach the loopback API (matching the documented install-level trust model in `README.md`/`auth.js`).

Practical consequence: there's no "current user" for the Access tab to compare against, so a precise *"you can't remove your own owner role"* guard isn't implementable without first adding some notion of session identity to the browser UI — out of scope here. The last-owner guard in §2.3 is the identity-agnostic substitute: it can't tell *you're* about to lock yourself out specifically, but it guarantees *someone* stays an owner, which is the actual failure this tab exists to prevent. If session/login is added later, this is the natural place to revisit and tighten.

---

## 8. Testing

No direct test of `permissions.save`/`permissions.list` exists today (grep confirms) — new coverage needed regardless of which endpoints ship, in `api/test/contract.test.js` style:

- `permissions.upsert` as owner → row created; re-fetch via `permissions.list` confirms it.
- `permissions.upsert` changing an existing email's role → old row replaced, not duplicated (`SELECT COUNT(*)` = 1 for that email+company).
- `permissions.upsert`/`permissions.delete` as non-owner (viewer/data_entry/agent identity) → `FORBIDDEN`, matching the existing `auth-tokens.test.js` pattern for `permissions.list`.
- `permissions.delete` on the only owner row → `INVALID_STATE`, row untouched.
- `permissions.delete` on the only *company-scoped* owner when a `'*'`-scoped owner also exists → succeeds (§2.3's counting rule).
- `permissions.upsert`/`permissions.delete` never touch `company_id = '*'` rows even when an email collides with a global grant (regression guard for §2.4).
- Live-browser cycle per `fb-list-ux-spec.md` §12: add-row → Esc-blank vanishes → add → fill → `w` lands server-side → edit role → `w` → `x` with confirm → gone.

---

## 9. Open questions / explicitly deferred

1. **Managing `'*'` (global) grants themselves.** This tab surfaces them read-only; creating/editing/revoking a cross-company grant has no UI anywhere and stays deferred, same as `settings-ux-spec.md` §7 always intended (paired with an eventual audit-log viewer).
2. ~~`agent-loop.js`'s `getAgentAccount` missing `OR company_id = '*'`~~ — resolved by §2.6: the rewritten `getAgentAccount()` already includes `OR company_id = '*'` in both its configured-email check and its zero-config candidate query, so this is fixed as a byproduct rather than a separate loose end.
3. **Retire `permissions.save` or keep it?** No caller today; Centers kept its bulk `center.save` around post-migration rather than force a removal in the same PR. Same "implementer's call, low urgency" applies here.
4. **AI-tab tie-in (§4)** is no longer optional polish, per §2.6's sequencing note — the `agent_pipeline_email` picker should land alongside the Access tab itself, not as a follow-up.
5. **`granted_by` will be `null`** for grants made through this tab in the default trust mode, for the same reason §7 describes (no identity on browser calls). Harmless today (nothing reads it back), but worth knowing before treating it as an audit trail.
