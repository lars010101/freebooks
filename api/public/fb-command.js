/* fb-command.js — typed-command grammar extension to FB.palette (command-bar-ux-spec.md)
 *
 * Extends the existing `:` command palette (FB.palette in fb-core.js) with
 * a typed-argument grammar for high-frequency commands. The palette's
 * derive-only model (page verbs, API actions, route commands) is retained
 * unchanged — this layer adds alias parsing on top, never replacing the
 * raw catalog escape hatch (Tier 0).
 *
 * Load order: after fb-core.js, before fb-list.js (see commonStyle()).
 */
(function () {
  'use strict';

  // ── Alias table (spec §4) ──────────────────────────────────────────────────
  // Each alias is sugar over a real <module>.<verb> action from the catalog.
  // Fields:
  //   action:   the catalog action name to resolve to (null = page verb or route)
  //   grammar:  hint string shown under the bar while typing
  //   bang:     true if ! is supported (spec §7)
  //   parse:    function(tokens, bang) → { action?, params?, route?, prefill?,
  //                                        commitMode, warnings?, pageVerb?, error? }
  var ALIASES = {
    'post': {
      action: 'journal.post',
      grammar: '<amount> <account> [from <account>] [due <date>] [!]',
      bang: true,
      parse: parsePost
    },
    'je': {
      action: 'journal.post',
      grammar: '(no args — opens blank journal form)',
      bang: false,
      parse: function () { return { route: '/journal/new', commitMode: 'form' }; }
    },
    'bill': {
      action: 'bill.draft.save',
      grammar: '<partner> <amount> [due <date>] [vat <amt>|net <amt>|rc]',
      bang: false, // deferred per spec §10
      parse: parseBill
    },
    'pay': {
      action: 'bill.payment.record',
      grammar: '<partner> <amount> from <account> [!]',
      bang: true,
      parse: parsePay
    },
    'void': {
      action: 'bill.void',
      grammar: '<bill-ref>',
      bang: false,
      parse: parseVoid
    },
    'match': {
      action: 'bank.match',
      grammar: '(focused line — no args)',
      bang: false,
      parse: function () { return { action: 'bank.match', commitMode: 'form' }; }
    },
    'approve': {
      action: null,
      pageVerb: 'y', scope: 'inbox',
      grammar: '(approves focused inbox item)',
      bang: false,
      parse: function () { return { pageVerb: 'y', commitMode: 'direct' }; }
    },
    'reject': {
      action: null,
      pageVerb: 'x', scope: 'inbox',
      grammar: '(rejects focused inbox item)',
      bang: false,
      parse: function () { return { pageVerb: 'x', commitMode: 'direct' }; }
    },
    'report': {
      action: null,
      grammar: '(navigates to Reports hub)',
      bang: false,
      parse: function () { return { route: '/reports', commitMode: 'navigate' }; }
    },
    'rate': {
      action: 'fx.rates.save',
      grammar: '<currency> <rate>',
      bang: false,
      parse: parseRate
    },
    'lock': {
      action: 'period.save',
      grammar: '<month>',
      bang: false,
      parse: parseLock
    },
    'unlock': {
      action: 'period.save',
      grammar: '<month>',
      bang: false,
      parse: parseUnlock
    },
    'partner': {
      action: 'partner.upsert',
      grammar: 'add <name> [net<days>]',
      bang: false,
      parse: parsePartner
    },
    'token': {
      action: null,
      grammar: 'create <name> | revoke <name>',
      bang: false,
      parse: parseToken
    }
  };

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

  // ── Date parser ─────────────────────────────────────────────────────────────
  function parseDate(s) {
    if (!s) return null;
    s = s.toLowerCase().trim();
    if (s === 'today') return new Date().toISOString().slice(0, 10);
    var rel = s.match(/^\+(\d+)d$/);
    if (rel) {
      var d = new Date();
      d.setDate(d.getDate() + parseInt(rel[1], 10));
      return d.toISOString().slice(0, 10);
    }
    var shortDate = s.match(/^([a-z]{3})(\d{1,2})$/);
    if (shortDate) {
      var months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                     jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
      var mo = months[shortDate[1]];
      if (!mo) return null;
      var day = shortDate[2].length < 2 ? '0' + shortDate[2] : shortDate[2];
      return new Date().getFullYear() + '-' + mo + '-' + day;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  function parseAmount(s) {
    if (!s) return null;
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return n;
  }

  // ── Keyword-slot extractor ──────────────────────────────────────────────────
  var KEYWORDS = ['from', 'to', 'due', 'on', 'vat', 'net', 'rc'];

  function extractSlots(tokens) {
    var positional = [];
    var slots = {};
    var i = 0;
    while (i < tokens.length) {
      var kw = tokens[i].toLowerCase();
      if (KEYWORDS.indexOf(kw) !== -1) {
        if (kw === 'rc') {
          slots.rc = true;
          i++;
        } else if (i + 1 < tokens.length) {
          slots[kw] = tokens[i + 1];
          i += 2;
        } else {
          return { positional: positional, slots: slots, error: 'keyword "' + kw + '" needs a value' };
        }
      } else {
        positional.push(tokens[i]);
        i++;
      }
    }
    return { positional: positional, slots: slots };
  }

  // ── Per-alias parsers ───────────────────────────────────────────────────────

  function parsePost(tokens, bang) {
    var ex = extractSlots(tokens);
    if (ex.error) return { error: ex.error };
    var pos = ex.positional;
    if (pos.length < 2) return { error: 'usage: :post <amount> <account> [from <account>]' };
    var amount = parseAmount(pos[0]);
    if (amount === null) return { error: 'invalid amount: ' + pos[0] };
    var warnings = [];
    if (bang) {
      return {
        action: 'journal.post',
        params: { amount: amount, account: pos[1], fromAccount: ex.slots.from || null, date: ex.slots.due ? parseDate(ex.slots.due) : null },
        commitMode: 'direct',
        warnings: warnings
      };
    }
    return {
      route: '/journal/new',
      prefill: { amount: amount, account: pos[1], fromAccount: ex.slots.from || null, date: ex.slots.due ? parseDate(ex.slots.due) : null },
      commitMode: 'form',
      warnings: warnings
    };
  }

  function parseBill(tokens, bang) {
    var ex = extractSlots(tokens);
    if (ex.error) return { error: ex.error };
    var pos = ex.positional;
    if (pos.length < 2) return { error: 'usage: :bill <partner> <amount> [due <date>] [vat <amt>|net <amt>|rc]' };
    var partner = pos[0];
    var amount = parseAmount(pos[1]);
    if (amount === null) return { error: 'invalid amount: ' + pos[1] };
    var warnings = [];
    // Per spec §4: bare number = net (saveDraftBill stores as net, vat_amount: 0)
    var params = { partner: partner, amount: amount, date: ex.slots.due ? parseDate(ex.slots.due) : null };
    if (ex.slots.vat) {
      var vatAmt = parseAmount(ex.slots.vat);
      if (vatAmt === null) return { error: 'invalid vat amount: ' + ex.slots.vat };
      params.lines = [{ amount: amount, vat_code: null, vat_amount: vatAmt }];
    } else if (ex.slots.net) {
      var netAmt = parseAmount(ex.slots.net);
      if (netAmt === null) return { error: 'invalid net amount: ' + ex.slots.net };
      params.lines = [{ amount: netAmt, vat_code: null, vat_amount: amount - netAmt }];
    } else if (ex.slots.rc) {
      params.lines = [{ amount: amount, vat_code: 'RC', vat_amount: 0 }];
      warnings.push('reverse charge — VAT not captured locally');
    }
    // :bill always creates a draft (bill.draft.save) — bang deferred (spec §10)
    return {
      action: 'bill.draft.save',
      params: params,
      commitMode: 'direct',
      warnings: warnings
    };
  }

  function parsePay(tokens, bang) {
    var ex = extractSlots(tokens);
    if (ex.error) return { error: ex.error };
    var pos = ex.positional;
    if (pos.length < 2) return { error: 'usage: :pay <partner> <amount> from <account>' };
    if (!ex.slots.from) return { error: 'usage: :pay <partner> <amount> from <account>' };
    var partner = pos[0];
    var amount = parseAmount(pos[1]);
    if (amount === null) return { error: 'invalid amount: ' + pos[1] };
    var warnings = [];
    if (bang) {
      return {
        action: 'bill.payment.record',
        params: { partner: partner, amount: amount, fromAccount: ex.slots.from },
        commitMode: 'direct',
        warnings: warnings
      };
    }
    return {
      route: '/payables',
      prefill: { partner: partner, amount: amount, fromAccount: ex.slots.from },
      commitMode: 'form',
      warnings: warnings
    };
  }

  function parseVoid(tokens) {
    if (!tokens.length) return { error: 'usage: :void <bill-ref>' };
    return { action: 'bill.void', params: { billRef: tokens[0] }, commitMode: 'confirm' };
  }

  function parseRate(tokens) {
    if (tokens.length < 2) return { error: 'usage: :rate <currency> <rate>' };
    var rate = parseFloat(tokens[1]);
    if (isNaN(rate)) return { error: 'invalid rate: ' + tokens[1] };
    return { action: 'fx.rates.save', params: { currency: tokens[0].toUpperCase(), rate: rate }, commitMode: 'form' };
  }

  function parseLock(tokens) {
    if (!tokens.length) return { error: 'usage: :lock <month>' };
    return { action: 'period.save', params: { period: tokens[0].toLowerCase(), locked: true }, commitMode: 'confirm' };
  }

  function parseUnlock(tokens) {
    if (!tokens.length) return { error: 'usage: :unlock <month>' };
    return { action: 'period.save', params: { period: tokens[0].toLowerCase(), locked: false }, commitMode: 'confirm' };
  }

  function parsePartner(tokens) {
    if (tokens.length < 2) return { error: 'usage: :partner add <name> [net<days>]' };
    if (tokens[0].toLowerCase() !== 'add') return { error: 'usage: :partner add <name> [net<days>]' };
    var name = tokens[1];
    var netDays = 30;
    if (tokens[2]) {
      var m = tokens[2].match(/^net(\d+)$/);
      if (m) netDays = parseInt(m[1], 10);
    }
    return { action: 'partner.upsert', params: { name: name, paymentTermsDays: netDays }, commitMode: 'form' };
  }

  function parseToken(tokens) {
    if (tokens.length < 2) return { error: 'usage: :token create <name> | revoke <name>' };
    var sub = tokens[0].toLowerCase();
    var name = tokens[1];
    if (sub === 'create') return { action: 'auth.token.create', params: { name: name }, commitMode: 'confirm' };
    if (sub === 'revoke') return { action: 'auth.token.revoke', params: { name: name }, commitMode: 'confirm' };
    return { error: 'usage: :token create <name> | revoke <name>' };
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
    tk.tokens.shift();
    var bang = tk.bang;

    if (ALIASES[verb]) {
      var alias = ALIASES[verb];
      if (bang && !alias.bang) return { type: 'unknown', error: ':' + verb + ' does not support !' };
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
    parseDate: parseDate,
    parseAmount: parseAmount,
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
