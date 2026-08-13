/**
 * fb-attachments.js — Shared attachment queue: row rendering + j/k/x nav.
 *
 * K4 unification (docs/keyboard-ux-spec.md §9 ratified):
 *   - `A` = attach on every page that has attachments (page-level FB.keys verb)
 *   - The attachment queue/panel is navigable: j/k move the cursor, x deletes
 *     via the page's EXISTING delete path (confirm preserved as-is), Enter =
 *     the existing download/open behavior.
 *
 * This module owns the shared row HTML + a lightweight cursor controller. Each
 * page declares its delete/download handlers; the machine owns j/k focus + x.
 * Pages that already have a combined j/k nav (bill-detail: meta→lines→attach)
 * do NOT use createNav — they fold attachment rows into their own nav and only
 * use rowHtml. Pages with a standalone attachment panel (journal-voucher) use both.
 *
 * NOT FB.list: attachments are read-only display rows (no inline edit, no add
 * row — `A` is the create verb, not an add row). FB.list is for editable
 * table registers. The attachment queue is a nav+delete surface.
 */
(function () {
  'use strict';
  if (!window.FB) window.FB = {};
  var FB = window.FB;

  FB.attachments = {
    /**
     * Render one uploaded-attachment row (shared markup).
     * @param {object} a — { attachment_id, filename, file_size, created_at }
     * @returns {string} HTML for a .fb-attach-row div
     */
    rowHtml: function (a) {
      var id = a.attachment_id || a.id || '';
      var name = a.filename || a.file_name || 'file';
      var kb = a.file_size ? (a.file_size / 1024).toFixed(1) : '';
      var date = a.created_at
        ? new Date(a.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '';
      var metaParts = [];
      if (date) metaParts.push(date);
      if (kb) metaParts.push(kb + ' KB');
      var meta = metaParts.length
        ? ' <span class="fb-att-meta">' + FB.util.esc(metaParts.join(' \u2022 ')) + '</span>'
        : '';
      return '<div class="fb-attach-row" data-att-id="' + FB.util.esc(String(id)) + '">'
        + '<span class="fb-att-icon">\uD83D\uDCC4</span>'
        + '<a class="fb-att-link" href="/api/attachments/' + FB.util.esc(String(id))
        + '" target="_blank" title="open">' + FB.util.esc(name) + '</a>'
        + meta
        + '<button class="fb-att-del" data-att-id="' + FB.util.esc(String(id))
        + '" title="delete (x)">\u00d7</button>'
        + '</div>';
    },

    /**
     * Render an empty-state message row.
     * @param {string} msg
     * @returns {string}
     */
    emptyHtml: function (msg) {
      return '<div class="fb-attach-empty">' + FB.util.esc(msg || 'No attachments.') + '</div>';
    },

    /**
     * Create a lightweight j/k/x cursor controller for a container of
     * .fb-attach-row elements. The page wires these into its FB.keys set
     * (extraBindings) — this controller does NOT register keys itself.
     *
     * @param {object} opts
     *   container {string|Element}  selector or element holding .fb-attach-row
     *   focusClass {string}         CSS class for the focused row (default 'fb-attach-focus')
     *   onDelete {function(attId, row)}  called by del(); page owns the fetch + confirm
     *   onDownload {function(attId, row)|null}  called by open(); null = no Enter binding
     * @returns {object} { move, first, clear, current, del, open, refresh }
     */
    createNav: function (opts) {
      opts = opts || {};
      var containerSel = opts.container;
      var focusClass = opts.focusClass || 'fb-attach-focus';
      var onDelete = opts.onDelete || function () {};
      var onDownload = opts.onDownload || null;

      function container() {
        return typeof containerSel === 'string'
          ? document.querySelector(containerSel)
          : containerSel;
      }
      function rows() {
        var c = container();
        return c ? Array.from(c.querySelectorAll('.fb-attach-row')) : [];
      }
      function focused() {
        var c = container();
        return c ? c.querySelector('.fb-attach-row.' + focusClass) : null;
      }
      function clear() {
        rows().forEach(function (r) { r.classList.remove(focusClass); });
      }
      function setCursor(row) {
        clear();
        if (row) {
          row.classList.add(focusClass);
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }
      function move(dir) {
        var rs = rows();
        if (!rs.length) return;
        var cur = focused();
        var idx = cur ? rs.indexOf(cur) : -1;
        var next = idx === -1
          ? (dir > 0 ? 0 : rs.length - 1)
          : Math.max(0, Math.min(rs.length - 1, idx + dir));
        setCursor(rs[next]);
      }
      function first() { var rs = rows(); if (rs.length) setCursor(rs[0]); }
      function currentRow() { return focused(); }
      function currentId() { var r = focused(); return r ? r.dataset.attId : null; }
      function del() {
        var r = focused();
        if (!r) return;
        onDelete(r.dataset.attId, r);
      }
      function open() {
        if (!onDownload) return;
        var r = focused();
        if (!r) return;
        onDownload(r.dataset.attId, r);
      }
      function refresh() { /* re-bind row button handlers if needed */ }
      return {
        move: move, first: first, clear: clear,
        currentRow: currentRow, currentId: currentId,
        del: del, open: open, refresh: refresh,
        rows: rows
      };
    }
  };
})();
