/* fb-command.js — `:` alias parsing (now empty), plus `/` search-scope
 * parsing (global-search-spec.md)
 *
 * `:` is retired entirely. Its last two commands, vat-tolerance/gst-tolerance,
 * are gone — VAT/GST tolerance is edited through Settings → Extensions
 * (posting_rules.attr.save), which was already its real UI surface, making
 * the command-bar path redundant. ALIASES is now empty; parse()/tokenize()/
 * grammarFor() remain as general-purpose infrastructure (Tier-0 raw
 * catalog-action parsing, unknown-command handling).
 *
 * parseSearchScope()/SEARCH_SCOPES are NOT part of any of this — fb-core.js's
 * FB.search calls parseSearchScope directly for the `/p:`/`/a:`/`/j:`/`/b:`
 * power-user fast paths (global-search-spec.md §7).
 *
 * Load order: after fb-core.js, before fb-list.js (see commonStyle()).
 */
(function () {
  'use strict';

  // ── Alias table — empty. vat-tolerance/gst-tolerance retired; both are
  // now edited via Settings → Extensions instead of a `:` command. ─────────
  var ALIASES = {};

  // ── Tokenizer ──────────────────────────────────────────────────────────────
  // Whitespace-tokenized; double-quotes for multi-word entities.
  // Trailing ! is extracted as the bang flag.
  function tokenize(input) {
    var tokens = [];
    var i = 0, s = input.trim();
    while (i < s.length) {
      while (i < s.length && s[i] === ' ') i++;
      if (i >= s.length) break;
      if (s[i] === '"') {
        var end = s.indexOf('"', i + 1);
        if (end === -1) { tokens.push(s.slice(i + 1)); i = s.length; }
        else { tokens.push(s.slice(i + 1, end)); i = end + 1; }
      } else {
        var sp = s.indexOf(' ', i);
        if (sp === -1) { tokens.push(s.slice(i)); i = s.length; }
        else { tokens.push(s.slice(i, sp)); i = sp; }
      }
    }
    var bang = false;
    if (tokens.length && tokens[tokens.length - 1] === '!') {
      bang = true;
      tokens.pop();
    }
    return { tokens: tokens, bang: bang };
  }

  // ── Main parse entry ────────────────────────────────────────────────────────
  function parse(input) {
    var raw = input;
    if (raw.charAt(0) === ':') raw = raw.slice(1);
    raw = raw.trim();
    if (!raw) return { type: 'empty' };

    var tk = tokenize(raw);
    if (!tk.tokens.length) return { type: 'empty' };
    var verb = tk.tokens[0].toLowerCase();
    var bang = tk.bang;
    tk.tokens.shift();

    if (ALIASES[verb]) {
      var alias = ALIASES[verb];
      if (bang && !alias.bang) return { type: 'unknown', error: ':' + verb + ' does not support !' };
      if (!alias.parse) return { type: 'unknown', error: ':' + verb + ' is a browse command — use the dropdown' };
      var parsed = alias.parse(tk.tokens, bang);
      if (parsed.error) return { type: 'unknown', error: parsed.error };
      if (bang && parsed.warnings && parsed.warnings.length) parsed.commitMode = 'form';
      return { type: 'alias', alias: verb, parsed: parsed, bang: bang, grammar: alias.grammar };
    }

    // Tier 0: raw catalog action (e.g. :journal.propose companyId=...)
    if (verb.indexOf('.') !== -1) return { type: 'raw', action: verb, params: tk.tokens };

    return { type: 'unknown', error: 'unknown command: ' + verb };
  }

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
    parse: parse,
    tokenize: tokenize,
    ALIASES: ALIASES,
    parseSearchScope: parseSearchScope,
    SEARCH_SCOPES: SEARCH_SCOPES,
    grammarFor: function (alias) {
      var a = ALIASES[alias];
      return a ? a.grammar : null;
    }
  };
})();
