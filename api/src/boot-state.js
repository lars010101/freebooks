'use strict';
/**
 * Boot-state (B9) — holds references to the in-process feed watcher and
 * agent loop instances. These are started by index.js at boot and read
 * by the agent.status action (handleAgent) to report status to the UI.
 *
 * This module exists to avoid a circular dependency: index.js requires
 * feed-watcher and agent-loop, which need a dispatchAction function that
 * calls back into index.js's dispatch logic.
 */

let _feedWatcher = null;
let _agentLoop = null;

function setFeedWatcher(fw) { _feedWatcher = fw; }
function setAgentLoop(al) { _agentLoop = al; }

Object.defineProperty(module.exports, 'feedWatcher', {
  get() { return _feedWatcher; },
});
Object.defineProperty(module.exports, 'agentLoop', {
  get() { return _agentLoop; },
});

module.exports.setFeedWatcher = setFeedWatcher;
module.exports.setAgentLoop = setAgentLoop;
