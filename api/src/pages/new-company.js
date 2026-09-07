'use strict';
const { commonStyle } = require('./common');

async function handleNewCompanyPage(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildNewCompanyPage());
}

// ── Route: POST /api/admin/query ──────────────────────────────────────────────

function buildNewCompanyPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>New Company — freeBooks</title>
${commonStyle()}
<style>
  .field-row { display:flex; flex-direction:column; gap:4px; margin-bottom:14px; }
  .field-row label { font-weight:600; font-size:0.8125rem; color:var(--text-muted); }
  .field-row input, .field-row select { padding:8px 12px; border:1px solid var(--border); border-radius:4px; font-size:0.8125rem; max-width:320px; background:var(--surface); color:var(--text); }
  .section-title { font-weight:700; font-size:0.875rem; margin:20px 0 10px; border-bottom:1px solid var(--border); padding-bottom:6px; }
  table.edit-table { width:100%; border-collapse:collapse; font-size:0.8125rem; margin-bottom:10px; }
  table.edit-table th { text-align:left; font-size:0.75rem; text-transform:uppercase; color:var(--text-muted); border-bottom:1px solid var(--border); padding:6px; }
  table.edit-table td { padding:4px 6px; border-bottom:1px solid var(--border); }
  table.edit-table input { width:100%; padding:4px 6px; border:1px solid var(--border); border-radius:3px; font-size:0.8125rem; }
  .msg { margin-top:10px; font-size:0.8125rem; }
  .msg.err { color:var(--danger); }
</style>
</head>
<body>
<div class="page">
  <div class="back"><a href="/">← All companies</a></div>
  <div class="header"><h1>New Company</h1></div>

  <div class="section-title">Company Details</div>
  <div class="field-row"><label>Company ID <small style="color:var(--text-muted)">(lowercase, underscores only)</small></label><input type="text" id="co-id" placeholder="myco_sg" pattern="[a-z0-9_]+"></div>
  <div class="field-row"><label>Company Name</label><input type="text" id="co-name"></div>
  <div class="field-row"><label>Currency</label><input type="text" id="co-currency" value="SGD" maxlength="3" style="max-width:80px"></div>
  <div class="field-row"><label>Jurisdiction</label>
    <select id="co-jurisdiction" style="max-width:120px">
      <option value="SG">SG — Singapore</option>
      <option value="SE">SE — Sweden</option>
    </select>
  </div>
  <div class="field-row"><label>Tax ID</label><input type="text" id="co-taxid" placeholder="e.g. 201703022E"></div>
  <div class="field-row"><label>Reporting Standard</label><input type="text" id="co-standard" value="SFRS"></div>
  <div class="field-row"><label><input type="checkbox" id="co-vat"> VAT / GST Registered</label></div>

  <div class="section-title">Fiscal Periods</div>
  <table class="edit-table">
    <thead><tr><th>Period Name</th><th>Start Date</th><th>End Date</th><th></th></tr></thead>
    <tbody id="periods-body"></tbody>
  </table>
  <button class="btn-sm" onclick="addRow()">+ Add Period</button>

  <div style="margin-top:24px;display:flex;gap:12px;align-items:center">
    <button class="btn-primary" id="btn-create" onclick="createCompany()">Create Company</button>
    <span id="msg" class="msg"></span>
  </div>
  <!-- K5: hint surface — no sidebar chrome on this page, so hints render
       inline here instead of the (absent) #sb-hints. -->
  <div class="fb-hint-bar" id="nc-hints" style="margin-top:14px"></div>
  <div id="post-links" style="display:none;margin-top:14px;display:none">
    <a id="lnk-jv" href="#" style="display:inline-block;padding:9px 20px;background:var(--accent);color:var(--on-accent);text-decoration:none;border-radius:4px;font-size:0.8125rem;font-weight:600;margin-right:10px">📝 Enter Journal Entry &rarr;</a>
    <a id="lnk-settings" href="#" style="display:inline-block;padding:9px 20px;background:var(--bg);color:var(--text);text-decoration:none;border-radius:4px;font-size:0.8125rem;border:1px solid var(--border)">⚙ Go to Settings</a>
  </div>
</div>
<script>
function addRow(p) {
  p = p || {};
  var tr = document.createElement('tr');
  tr.innerHTML = '<td><input type="text" value="'+(p.name||'')+'" placeholder="FY2026"></td>'
    +'<td><input type="date" value="'+(p.start||'')+'" ></td>'
    +'<td><input type="date" value="'+(p.end||'')+'" ></td>'
    +'<td><button class="btn-sm danger" onclick="this.parentElement.parentElement.remove()" aria-label="Remove period">✕</button></td>';
  document.getElementById('periods-body').appendChild(tr);
}
addRow();

function getFields() {
  return {
    company_id: document.getElementById('co-id').value.trim(),
    company_name: document.getElementById('co-name').value.trim(),
    currency: document.getElementById('co-currency').value.trim().toUpperCase(),
    jurisdiction: document.getElementById('co-jurisdiction').value,
    tax_id: document.getElementById('co-taxid').value.trim(),
    reporting_standard: document.getElementById('co-standard').value.trim(),
    vat_registered: document.getElementById('co-vat').checked,
  };
}

function getPeriods() {
  return Array.from(document.querySelectorAll('#periods-body tr')).map(tr => {
    var ins = tr.querySelectorAll('input');
    return { name: ins[0].value.trim(), start: ins[1].value, end: ins[2].value };
  }).filter(p => p.name && p.start && p.end);
}

function createCompany() {
  var co = getFields();
  var ps = getPeriods();
  var msg = document.getElementById('msg');
  document.getElementById('btn-create').disabled = true;
  fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ action:'setup.add_company', companyId: co.company_id,
      company: { ...co, fy_start: ps[0]&&ps[0].start, fy_end: ps[ps.length-1]&&ps[ps.length-1].end } }) })
    .then(r => r.json())
    .then(d => {
      if (d.error) { msg.textContent = (d.error && d.error.message) || 'Failed to create company.'; msg.className = 'msg err'; document.getElementById('btn-create').disabled = false; return; }
      if (ps.length === 0) {
        msg.textContent = 'Company created.';
        msg.className = 'msg';
        msg.style.color = 'var(--success)';
        document.getElementById('btn-create').textContent = 'Created \u2713';
        document.getElementById('post-links').style.display = '';
        document.getElementById('lnk-jv').href = '/'+co.company_id+'/journal/voucher';
        document.getElementById('lnk-settings').href = '/'+co.company_id+'/settings';
        return;
      }
      var periods = ps.map(p => ({ company_id: co.company_id, period_id: p.name, start_date: p.start, end_date: p.end, locked: false }));
      return fetch('/api/action', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ action:'period.save', companyId: co.company_id, periods }) })
        .then(() => {
          msg.textContent = 'Company created.';
          msg.className = 'msg';
          msg.style.color = 'var(--success)';
          document.getElementById('btn-create').textContent = 'Created ✓';
          document.getElementById('post-links').style.display = '';
          document.getElementById('lnk-jv').href = '/'+co.company_id+'/journal/voucher';
          document.getElementById('lnk-settings').href = '/'+co.company_id+'/settings';
        });
    })
    .catch(e => { msg.textContent = e.message; msg.className = 'msg err'; document.getElementById('btn-create').disabled = false; });
}

// ── FB.form (K3b, keyboard-ux-spec §8) — company fields (one zone row per
// .field-row, matching the vertical stack) → periods grid. a = add period,
// x = delete period, w = create company. No sidebar chrome on this page —
// hints render into the inline #nc-hints bar (K5).
var ncForm = FB.form.create({
  formId: 'new-company',
  zones: [
    { id: 'company', rows: function () { return Array.prototype.slice.call(document.querySelectorAll('.field-row')); } },
    { id: 'periods', rows: function () { return Array.prototype.slice.call(document.querySelectorAll('#periods-body tr')); } }
  ],
  verbs: {
    add: { key: 'a', hint: 'add period', run: function (api) {
      addRow();
      api.moveTo(1, api.zoneRows(1).length - 1, 0, true);
    } },
    delete: { key: 'x', hint: 'delete period',
      when: function (api) { return api.cur().z === 1; },
      run: function (api) {
        var tr = api.zoneRows(1)[api.cur().r];
        if (!tr) return;
        tr.remove();
        api.refresh();
      } },
    write: { key: 'w', hint: 'create', run: function () { createCompany(); } }
  }
});
FB.keys.renderHints('new-company', document.getElementById('nc-hints') || document.getElementById('sb-hints'), { layout: 'inline' });
</script>
</body>
</html>`;
}

module.exports = { handleNewCompanyPage };
