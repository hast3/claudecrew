'use strict';
// Scheduled jobs: "every weekday at 08:00, @webapp run the tests and report" or "every 4 hours".
// Stored in data/schedules.json and edited from the web page.
// If Crew was off at the scheduled time, a missed daily job still runs if Crew is back
// within CATCH_UP of it; older misses are skipped rather than piling up.

const fs = require('fs');
const crypto = require('crypto');

const CATCH_UP = 6 * 3600e3;

function createScheduler({ file, onDue }) {
  let jobs = [];
  try { jobs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  const save = () => fs.writeFileSync(file, JSON.stringify(jobs, null, 2));

  function clean(input, agentIds) {
    const j = {
      agent: String(input.agent || ''),
      text: String(input.text || '').trim().slice(0, 4000),
      kind: input.kind === 'interval' ? 'interval' : 'daily',
      time: /^\d{1,2}:\d{2}$/.test(input.time || '') ? input.time.padStart(5, '0') : '08:00',
      days: Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [1, 2, 3, 4, 5],
      everyHours: Math.min(168, Math.max(0.25, Number(input.everyHours) || 4)),
      enabled: input.enabled !== false,
    };
    if (!agentIds.includes(j.agent)) throw new Error('Pick an agent');
    if (!j.text) throw new Error('Write what the agent should do');
    if (j.kind === 'daily' && !j.days.length) throw new Error('Pick at least one day');
    return j;
  }

  // Most recent moment this daily job should have fired, at or before `now`.
  function lastSlot(job, now) {
    const [h, m] = job.time.split(':').map(Number);
    for (let back = 0; back < 8; back++) {
      const d = new Date(now);
      d.setDate(d.getDate() - back);
      d.setHours(h, m, 0, 0);
      if (d.getTime() <= now && job.days.includes(d.getDay())) return d.getTime();
    }
    return null;
  }

  function nextRun(job, now = Date.now()) {
    if (!job.enabled) return null;
    if (job.kind === 'interval') return Math.max(now, (job.lastRun || 0) + job.everyHours * 3600e3);
    const [h, m] = job.time.split(':').map(Number);
    for (let ahead = 0; ahead < 8; ahead++) {
      const d = new Date(now);
      d.setDate(d.getDate() + ahead);
      d.setHours(h, m, 0, 0);
      if (d.getTime() > now && job.days.includes(d.getDay())) return d.getTime();
    }
    return null;
  }

  function tick() {
    const now = Date.now();
    let changed = false;
    for (const job of jobs) {
      if (!job.enabled) continue;
      let due = false;
      if (job.kind === 'interval') {
        due = !job.lastRun || now - job.lastRun >= job.everyHours * 3600e3;
      } else {
        const slot = lastSlot(job, now);
        if (slot && (job.lastRun || job.created || 0) < slot && now - slot <= CATCH_UP) due = true;
      }
      if (due) {
        job.lastRun = now;
        changed = true;
        try { onDue(job); } catch (e) { console.error('schedule failed:', e.message); }
      }
    }
    if (changed) save();
  }

  const list = () => jobs.map((j) => ({ ...j, nextRun: nextRun(j) }));

  return {
    list,
    add(input, agentIds) {
      const j = { id: crypto.randomUUID(), created: Date.now(), ...clean(input, agentIds) };
      // Interval jobs first fire one interval from now, not immediately.
      if (j.kind === 'interval') j.lastRun = Date.now();
      jobs.push(j);
      save();
      return j;
    },
    update(id, input, agentIds) {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new Error('No such schedule');
      Object.assign(j, clean({ ...j, ...input }, agentIds));
      save();
      return j;
    },
    remove(id) {
      jobs = jobs.filter((x) => x.id !== id);
      save();
    },
    runNow(id) {
      const j = jobs.find((x) => x.id === id);
      if (!j) throw new Error('No such schedule');
      j.lastRun = Date.now();
      save();
      onDue(j);
    },
    start() { setInterval(tick, 30e3); setTimeout(tick, 5e3); },
    _tick: tick, // for tests
  };
}

module.exports = { createScheduler };
