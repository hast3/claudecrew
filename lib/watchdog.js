// Silent-run watchdog and hand-off-limit notice, kept apart from server.js so a test can drive
// them with short timers and fake agents.
//
// "Alive" means anything at all from the agent's run: a chat post, a tool call, or any output on
// its stream. The longest single command Claude Code allows is 10 minutes and it prints nothing
// while it waits, so the stop limit must stay well above that.
const LONGEST_COMMAND_MS = 10 * 60e3;
const DEFAULT_WARN_MS = 30 * 60e3;
const DEFAULT_STOP_MS = 60 * 60e3;

function createWatchdog(o) {
  const { agents, runtime, isPaused, post, stopWithSweep, wake } = o;
  const warnMs = o.warnMs ?? DEFAULT_WARN_MS;
  const stopMs = o.stopMs ?? DEFAULT_STOP_MS;
  const now = o.now || Date.now;
  const mins = (ms) => (ms >= 60e3 ? `${Math.round(ms / 60e3)} min` : `${Math.round(ms / 1000)} s`);

  function lastAlive(r) { return Math.max(r.lastAliveAt || 0, r.lastPostAt || 0, r.runStartedAt || 0); }

  function tick() {
    if (isPaused()) { for (const a of agents) { const r = runtime[a.id]; if (r.busy) r.lastAliveAt = now(); } return; }
    for (const a of agents) {
      const r = runtime[a.id];
      if (!r.busy || r.stopped || !r.runStartedAt) continue;
      const quiet = now() - lastAlive(r);
      if (quiet >= stopMs) {
        const job = r.runItem || 'its task';
        const why = `no chat post, tool call or output for ${mins(quiet)}`;
        post({ kind: 'system', text: `${a.name} was stopped: ${why} (working on ${job}).` });
        r.watchdogStopped = true;
        Promise.resolve(stopWithSweep(a.id)).catch(() => null).then((swept) => {
          wake(a, job, why, typeof swept === 'string' ? swept : '');
        });
      } else if (quiet >= warnMs && !r.silentWarned) {
        r.silentWarned = true;
        post({ kind: 'system', text: `${a.name} has been running ${mins(warnMs)} with no sign of activity on ${r.runItem}` });
      }
    }
  }
  return { tick, start(everyMs = 30e3) { return setInterval(tick, everyMs).unref(); } };
}

// A hand-off the chain-length limit refused: say so in the chat and wake the coordinator, once.
// Never wakes for a run that was itself a system notice, and at most once per cooldown, so it cannot loop.
function createLimitNotice(o) {
  const { post, wake } = o;
  const now = o.now || Date.now;
  const cooldownMs = o.cooldownMs ?? 10 * 60e3;
  let lastAt = -Infinity;
  return function notice(from, item, dropped, max) {
    if (!dropped.length) return false;
    const names = [...new Set(dropped.map((h) => h.name || h.id))].join(', ');
    post({ kind: 'system', text: `${from.name}'s hand-off to ${names} was not delivered: the chain reached its limit of ${max} hand-offs.` });
    if (item && item.fromId === 'crew') return false;
    if (now() - lastAt < cooldownMs) return false;
    lastAt = now();
    wake(from, dropped, max);
    return true;
  };
}

module.exports = { createWatchdog, createLimitNotice, LONGEST_COMMAND_MS, DEFAULT_WARN_MS, DEFAULT_STOP_MS };
