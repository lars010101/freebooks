/* fb-command.js — `/` search-scope parsing (global-search-spec.md)
 *
 * `:` command mode is retired entirely, including its parser (ALIASES,
 * tokenize(), parse(), grammarFor()) — removed 2026-09-05 after confirming
 * zero callers anywhere (the file's own comment had called this out as
 * "verify at build time" since the 2026-09-01 retirement; that verification
 * never happened until now). fb-core.js's FB.search calls parseSearchScope
 * directly for the `/p:`/`/a:`/`/j:`/`/b:` power-user fast paths
 * (global-search-spec.md §7) — that's the only thing this file does now.
 *
 * Load order: after fb-core.js, before fb-list.js (see commonStyle()).
 */
(function () {
  'use strict';

  // ── Scoped search prefixes (spec §4) ────────────────────────────────────────
  var SEARCH_SCOPES = { 'p': 'partner', 'a': 'account', 'j': 'journal', 'b': 'bill' };

  function parseSearchScope(input) {
    var q = input.slice(1);
    if (!q) return { scope: null, query: '' };
    if (q.length >= 2 && q[1] === ':') {
      var prefix = q[0].toLowerCase();
      if (SEARCH_SCOPES[prefix]) return { scope: SEARCH_SCOPES[prefix], query: q.slice(2) };
    }
    return { scope: null, query: q };
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.FB = window.FB || {};
  FB.command = {
    parseSearchScope: parseSearchScope,
    SEARCH_SCOPES: SEARCH_SCOPES
  };
})();
