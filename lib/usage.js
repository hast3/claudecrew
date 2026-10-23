'use strict';
// Usage tracking for Claude Crew.
//  - Plan limits: Claude Code reports your account's 5-hour and weekly utilization
//    (a "rate_limit_event") on every run. We keep the latest reading.
//  - Per-agent tallies: tokens, run count, time, and the pay-as-you-go API price of
//    each run (what it *would* cost on the API; your subscription isn't charged it).
//  - Budget guard: hold new work when a limit passes a threshold, until it resets.

const fs = require('fs');

const DAY_KEEP = 35;

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function emptyTally() {
  return { runs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUSD: 0, ms: 0 };
}
function addTally(into, t) {
  for (const k of Object.keys(into)) into[k] += t[k] || 0;
  return into;
}

function createUsage({ file, defaults = {} }) {
  let data = { limits: null, days: {}, budget: null, overrideUntil: 0 };
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { /* first run */ }
  data.budget = {
    enabled: defaults.enabled ?? true,
    fiveHour: defaults.fiveHour ?? 0.85,
    weekly: defaults.weekly ?? 0.95,
    ...(data.budget || {}),
  };

  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('usage save failed:', e.message); }
    }, 500);
  }

  function prune() {
    const cutoff = localDay(Date.now() - DAY_KEEP * 86400e3);
    for (const d of Object.keys(data.days)) if (d < cutoff) delete data.days[d];
  }

  // rate_limit_event.rate_limit_info from Claude Code's stream-json output.
  function recordLimits(info) {
    if (!info) return;
    const w = info.unifiedWindows || {};
    const win = (x) => (x && typeof x.utilization === 'number'
      ? { utilization: x.utilization, resetsAt: (x.resetsAt || 0) * 1000 } : null);
    data.limits = {
      status: info.status || null,
      fiveHour: win(w.five_hour) || (info.rateLimitType === 'five_hour' ? win(info) : null),
      weekly: win(w.seven_day) || (info.rateLimitType === 'seven_day' ? win(info) : null),
      usingOverage: !!info.isUsingOverage,
      updatedAt: Date.now(),
    };
    save();
  }

  // The final "result" event of a run.
  function recordRun(agentId, result) {
    const u = result?.usage || {};
    const day = localDay();
    data.days[day] ??= {};
    const t = (data.days[day][agentId] ??= emptyTally());
    addTally(t, {
      runs: 1,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheWrite: u.cache_creation_input_tokens || 0,
      costUSD: result?.total_cost_usd || 0,
      ms: result?.duration_ms || 0,
    });
    prune();
    save();
  }

  // A window whose reset time has passed is back to 0 until the next reading says otherwise.
  function currentWindow(w) {
    if (!w) return null;
    if (w.resetsAt && w.resetsAt <= Date.now()) return { utilization: 0, resetsAt: null, expired: true };
    return w;
  }

  function limits() {
    if (!data.limits) return null;
    return {
      ...data.limits,
      fiveHour: currentWindow(data.limits.fiveHour),
      weekly: currentWindow(data.limits.weekly),
    };
  }

  function tallies(agentIds) {
    const today = localDay();
    const weekStart = localDay(Date.now() - 6 * 86400e3);
    const out = {};
    const total = { today: emptyTally(), week: emptyTally() };
    for (const id of agentIds) out[id] = { today: emptyTally(), week: emptyTally() };
    for (const [day, perAgent] of Object.entries(data.days)) {
      if (day < weekStart) continue;
      for (const [id, t] of Object.entries(perAgent)) {
        out[id] ??= { today: emptyTally(), week: emptyTally() };
        addTally(out[id].week, t);
        addTally(total.week, t);
        if (day === today) { addTally(out[id].today, t); addTally(total.today, t); }
      }
    }
    return { agents: out, total };
  }

  // Returns why new work should wait, or null if it can run.
  function guard() {
    const b = data.budget;
    if (!b.enabled) return null;
    if (data.overrideUntil && data.overrideUntil > Date.now()) return null;
    const l = limits();
    if (!l) return null;
    const checks = [
      ['5-hour', l.fiveHour, b.fiveHour],
      ['weekly', l.weekly, b.weekly],
    ];
    for (const [name, w, limit] of checks) {
      if (w && w.resetsAt && w.utilization >= limit) {
        return { window: name, utilization: w.utilization, threshold: limit, resumesAt: w.resetsAt };
      }
    }
    return null;
  }

  // "Run anyway": ignore the guard until the window that tripped it resets.
  function override() {
    const g = guard();
    data.overrideUntil = g ? g.resumesAt : Date.now() + 3600e3;
    save();
  }

  function setBudget(b) {
    const clamp = (v, d) => (typeof v === 'number' && v > 0 && v <= 1 ? v : d);
    data.budget = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : data.budget.enabled,
      fiveHour: clamp(b.fiveHour, data.budget.fiveHour),
      weekly: clamp(b.weekly, data.budget.weekly),
    };
    if (data.overrideUntil && !guard()) data.overrideUntil = 0;
    save();
  }

  function summary(agentIds) {
    return {
      limits: limits(),
      budget: data.budget,
      overrideUntil: data.overrideUntil > Date.now() ? data.overrideUntil : 0,
      guard: guard(),
      ...tallies(agentIds),
    };
  }

  return { recordLimits, recordRun, guard, override, setBudget, summary };
}

module.exports = { createUsage, localDay };
