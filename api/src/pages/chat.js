'use strict';
/**
 * freeBooks — Chat with AI (docs/chat-with-ai-spec.md)
 *
 * Plain fetch + render page, not FB.list/FB.form — a message thread has no
 * list/form shape. Consent cards (§2c) render inline in the thread itself,
 * not a modal, so a scrolled-back conversation still shows what was asked
 * and decided.
 */
const { commonStyle, navBar, layoutEnd } = require('./common');

async function handleChatPage(req, res) {
  const { company } = req.params;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildChatPage(company));
}

function buildChatPage(company) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Chat with AI — freeBooks</title>
${commonStyle()}
<style>
  #chat-wrap { display:flex; flex-direction:column; height:calc(100vh - 96px); max-width:820px; margin:0 auto; }
  #chat-status { padding:8px 14px; font-size:0.8rem; color:var(--text-muted); border-bottom:1px solid var(--border); cursor:pointer; user-select:none; }
  #chat-thread { flex:1; overflow-y:auto; padding:16px 14px; display:flex; flex-direction:column; gap:10px; }
  .chat-msg { max-width:78%; padding:9px 12px; border-radius:10px; font-size:0.9rem; line-height:1.45; white-space:pre-wrap; }
  .chat-msg.user { align-self:flex-end; background:var(--accent); color:var(--on-accent); }
  .chat-msg.assistant { align-self:flex-start; background:var(--bg); color:var(--text); }
  .chat-msg.assistant.error { background:var(--danger-bg); color:var(--danger); border:1px solid var(--danger-border); }
  .chat-card { align-self:stretch; border:1px solid var(--warning-border); background:var(--warning-bg); border-radius:8px; padding:12px 14px; font-size:0.85rem; }
  .chat-card h4 { margin:0 0 6px; font-size:0.85rem; }
  .chat-card pre { max-height:180px; overflow:auto; background:var(--surface); border:1px solid var(--border); padding:8px; border-radius:6px; font-size:0.75rem; margin:6px 0; }
  .chat-card label { display:flex; align-items:center; gap:6px; font-size:0.8rem; margin:6px 0; }
  .chat-card .btns { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap; }
  .chat-card button { font-size:0.78rem; padding:4px 10px; border-radius:6px; border:1px solid var(--border); background:var(--surface); color:var(--text); cursor:pointer; }
  .chat-card button.primary { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
  /* Outline style, not solid fill: var(--danger) is intentionally lighter in
     dark mode (for text-on-surface legibility), which makes it fail contrast
     as a solid fill behind white text. Matches the .btn-sm.danger/.void-afford
     convention used elsewhere for destructive buttons. */
  .chat-card button.danger { background:var(--surface); color:var(--danger); border-color:var(--danger); }
  .chat-card button.danger:hover { background:var(--danger); color:var(--on-accent); }
  #chat-input-row { display:flex; gap:8px; padding:12px 14px; border-top:1px solid var(--border); }
  #chat-input { flex:1; padding:8px 12px; border:1px solid var(--border); border-radius:8px; font-size:0.9rem; background:var(--surface); color:var(--text); }
  #chat-send-btn { padding:8px 16px; border-radius:8px; border:none; background:var(--accent); color:var(--on-accent); font-size:0.9rem; cursor:pointer; }
  #chat-send-btn:disabled { background:var(--text-faint); cursor:default; }
  #chat-disclosure { padding:4px 14px 10px; font-size:0.72rem; color:var(--text-muted); }
  #chat-perms { padding:6px 14px 10px; font-size:0.75rem; }
  #chat-perms table { width:100%; border-collapse:collapse; }
  #chat-perms td, #chat-perms th { padding:3px 6px; border-bottom:1px solid var(--border); text-align:left; }
  #chat-perms button.revoke { font-size:0.7rem; padding:1px 6px; }
</style>
</head>
<body>
${navBar(company, 'chat')}
<div id="chat-wrap">
  <div id="chat-status" onclick="loadChatStatus()">Checking status…</div>
  <div id="chat-thread"></div>
  <div id="chat-perms" hidden></div>
  <div id="chat-input-row">
    <input type="text" id="chat-input" placeholder="Ask about the books, or ask me to book something…" autocomplete="off">
    <button id="chat-send-btn" onclick="sendChatMessage()">Send</button>
  </div>
  <div id="chat-disclosure">Bill and journal descriptions are sent to the LLM exactly as written when needed to answer — avoid putting sensitive personal details in them if using a cloud LLM endpoint. <a href="#" onclick="toggleChatPerms();return false;">Manage data permissions</a></div>
</div>
<script>
var COMPANY = ${JSON.stringify(company)};

function postAction(action, extra) {
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ action: action, companyId: COMPANY }, extra)) })
    .then(function (r) { return r.json(); });
}

// Agent-loop / feed-watcher status lives on the Inbox page (the pipeline
// that feeds it) — this strip only covers what's specific to chat itself.
function fmtStatus(d) {
  if (!d) return 'Status unavailable';
  var ai = d.ai_connection || {};
  return 'LLM: ' + (ai.ok ? 'Reachable' : ('Unreachable' + (ai.error ? ' (' + ai.error + ')' : '')));
}

function loadChatStatus() {
  var el = document.getElementById('chat-status');
  el.textContent = 'Checking status…';
  postAction('ai.test_connection', {}).then(function (aiRes) {
    el.textContent = fmtStatus({ ai_connection: (aiRes && aiRes.data) || {} });
  }).catch(function () { el.textContent = 'Status unavailable'; });
}

function appendMsg(role, content, isError) {
  var thread = document.getElementById('chat-thread');
  var div = document.createElement('div');
  div.className = 'chat-msg ' + role + (isError ? ' error' : '');
  div.textContent = content;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  return div;
}

function loadHistory() {
  postAction('chat.history.list', { limit: 200 }).then(function (res) {
    var msgs = (res && res.data && res.data.messages) || [];
    msgs.forEach(function (m) { appendMsg(m.role, m.content); });
  });
}

var _pendingCards = {}; // category -> card element, for the current in-flight turn

function renderCard(turnId, item) {
  var thread = document.getElementById('chat-thread');
  var card = document.createElement('div');
  card.className = 'chat-card';
  var aliasBox = item.aliasable
    ? '<label><input type="checkbox" class="chat-alias-cb" checked> Send names as aliases (e.g. \\'Vendor_7\\') instead of real names</label>'
    : '';
  card.innerHTML = '<h4>AI wants to see: ' + esc(item.label) + '</h4>'
    + aliasBox
    + '<pre class="chat-preview"></pre>'
    + '<div class="btns">'
    + '<button class="primary" data-d="approve_once">Approve once</button>'
    + '<button class="primary" data-d="allow_always">Always allow</button>'
    + '<button data-d="deny_once">Deny once</button>'
    + '<button class="danger" data-d="deny_never">Never allow</button>'
    + '</div>';
  var pre = card.querySelector('.chat-preview');
  var cb = card.querySelector('.chat-alias-cb');
  function renderPreview() {
    var showAliased = cb && cb.checked && item.dataAliased;
    pre.textContent = JSON.stringify(showAliased ? item.dataAliased : item.data, null, 2);
  }
  renderPreview();
  if (cb) cb.addEventListener('change', renderPreview);
  card.querySelectorAll('button[data-d]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      card.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      var aliased = !!(cb && cb.checked);
      postAction('chat.permission.decide', { turnId: turnId, category: item.category, decision: btn.dataset.d, aliased: aliased })
        .then(function (res) { handleSendResult(turnId, res); })
        .catch(function (e) { appendMsg('assistant', 'Error: ' + (e && e.message || e), true); });
    });
  });
  thread.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
}

function handleSendResult(turnId, res) {
  var d = res && res.data;
  if (!res || res.error || (d && d.error)) {
    appendMsg('assistant', 'Error: ' + ((res && res.error && res.error.message) || (d && d.error) || 'request failed'), true);
    setSendEnabled(true);
    return;
  }
  if (d && d.status === 'pending_permission') {
    if (Array.isArray(d.pending)) d.pending.forEach(function (item) { renderCard(turnId, item); });
    setSendEnabled(false, true); // keep disabled — the turn isn't done, cards handle the rest
    return;
  }
  // Completed turn — the user message was already shown optimistically; only
  // render the assistant's reply now.
  if (d) appendMsg('assistant', d.reply || '', !!d.error);
  setSendEnabled(true);
}

function setSendEnabled(enabled) {
  document.getElementById('chat-send-btn').disabled = !enabled;
  document.getElementById('chat-input').disabled = !enabled;
}

function sendChatMessage() {
  var input = document.getElementById('chat-input');
  var message = input.value.trim();
  if (!message) return;
  appendMsg('user', message);
  input.value = '';
  setSendEnabled(false);
  var turnId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('turn-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  postAction('chat.send', { message: message, turnId: turnId })
    .then(function (res) { handleSendResult(turnId, res); })
    .catch(function (e) { appendMsg('assistant', 'Error: ' + (e && e.message || e), true); setSendEnabled(true); });
}

document.getElementById('chat-input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
});

function toggleChatPerms() {
  var el = document.getElementById('chat-perms');
  el.hidden = !el.hidden;
  if (!el.hidden) loadChatPerms();
}

function loadChatPerms() {
  var el = document.getElementById('chat-perms');
  el.innerHTML = 'Loading…';
  postAction('chat.permissions.list', {}).then(function (res) {
    var perms = (res && res.data && res.data.permissions) || [];
    if (!perms.length) { el.innerHTML = '<em>No standing permissions yet — you\\'ll be asked the first time a category is needed.</em>'; return; }
    var rows = perms.map(function (p) {
      return '<tr><td>' + esc(p.category) + '</td><td>' + esc(p.decision) + (p.aliased ? ' (aliased)' : '') + '</td>'
        + '<td><button class="revoke" data-cat="' + esc(p.category) + '">Reset</button></td></tr>';
    }).join('');
    el.innerHTML = '<table><tr><th>Category</th><th>Decision</th><th></th></tr>' + rows + '</table>';
    el.querySelectorAll('button.revoke').forEach(function (btn) {
      btn.addEventListener('click', function () {
        postAction('chat.permissions.revoke', { category: btn.dataset.cat }).then(function () { loadChatPerms(); });
      });
    });
  });
}

loadChatStatus();
loadHistory();
</script>
${layoutEnd()}
</body>
</html>`;
}

module.exports = { handleChatPage };
