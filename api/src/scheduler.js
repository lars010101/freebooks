'use strict';
/**
 * freeBooks — background job scheduler (#311).
 *
 * One registry for the server's periodic jobs (notification scanners and
 * garbage collectors), replacing a separate boot call + setInterval per job.
 * Each job runs once at start (unless runAtStart is false), then every
 * intervalMs. start() resolves once the start runs of jobs registered with
 * awaitStart have finished (the GCs, which boot used to await); the other
 * start runs continue in the background. Shared behaviour:
 *   - errors are caught and logged with the job's name; a failing job never
 *     stops the others or the server;
 *   - a run is skipped if the previous run of the same job is still going;
 *   - timers are unref'd, so they never keep the process alive;
 *   - FREEBOOKS_SCHEDULER=off disables every job (tests, one-off scripts).
 *
 * The agent pipeline (agent-loop.js, feed-watcher.js) keeps its own
 * start/stop lifecycle and is not scheduled here.
 */

const jobs = new Map();
let started = false;

function register({ name, intervalMs, run, runAtStart = true, awaitStart = false }) {
  if (!name || typeof run !== 'function') throw new Error('scheduler.register needs a name and a run function');
  if (!(intervalMs > 0)) throw new Error(`scheduler job ${name}: intervalMs must be a positive number`);
  if (jobs.has(name)) throw new Error(`scheduler job ${name} is already registered`);
  jobs.set(name, { name, intervalMs, run, runAtStart, awaitStart, timer: null, running: false, lastRunAt: null, lastError: null, runs: 0 });
}

async function runJob(job) {
  if (job.running) {
    console.warn(`[scheduler] ${job.name}: previous run still in progress, skipping`);
    return;
  }
  job.running = true;
  job.lastRunAt = new Date().toISOString();
  try {
    await job.run();
    job.lastError = null;
  } catch (e) {
    job.lastError = String((e && e.message) || e);
    console.error(`[scheduler] ${job.name} failed: ${job.lastError}`);
  } finally {
    job.running = false;
    job.runs++;
  }
}

function enabled() {
  return String(process.env.FREEBOOKS_SCHEDULER || '').toLowerCase() !== 'off';
}

async function start() {
  if (started) return;
  started = true;
  if (!enabled()) {
    console.log('[scheduler] disabled (FREEBOOKS_SCHEDULER=off)');
    return;
  }
  const awaited = [];
  for (const job of jobs.values()) {
    if (job.runAtStart) {
      const p = runJob(job);
      if (job.awaitStart) awaited.push(p);
    }
    job.timer = setInterval(() => { runJob(job); }, job.intervalMs);
    job.timer.unref();
  }
  console.log(`[scheduler] started ${jobs.size} jobs: ${[...jobs.keys()].join(', ')}`);
  await Promise.all(awaited);
}

function stop() {
  for (const job of jobs.values()) {
    if (job.timer) clearInterval(job.timer);
    job.timer = null;
  }
  started = false;
}

function status() {
  return [...jobs.values()].map(({ name, intervalMs, running, lastRunAt, lastError, runs }) =>
    ({ name, intervalMs, running, lastRunAt, lastError, runs }));
}

module.exports = { register, start, stop, status, runJob, _jobs: jobs };
