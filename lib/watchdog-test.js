// Drives the watchdog and the hand-off-limit notice with shortened timers and a fake clock.
// Run by npm run check; never touches the live server.
const { createWatchdog, createLimitNotice, LONGEST_COMMAND_MS, DEFAULT_STOP_MS } = require('./watchdog');

function runTests() {
  const out = [];
  const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
  let t = 1000;
  const now = () => t;

  // The real stop limit must leave room for the longest single command.
  if (DEFAULT_STOP_MS < LONGEST_COMMAND_MS * 2) out.push('stop limit is too close to the longest command timeout');

  const agents = [{ id: 'busy1', name: 'Busy' }, { id: 'quiet1', name: 'Quiet' }, { id: 'owner1', name: 'ByOwner' }];
  const mk = () => ({ busy: true, stopped: false, runStartedAt: t, lastPostAt: t, lastAliveAt: t, runItem: 'the job text', silentWarned: false });
  const runtime = { busy1: mk(), quiet1: mk(), owner1: mk() };
  runtime.owner1.stopped = true; // the owner pressed Stop: stopAgent already set this
  const posts = [], stops = [], wakes = [];
  const wd = createWatchdog({
    agents, runtime, now, isPaused: () => false, warnMs: 30, stopMs: 60,
    post: (m) => posts.push(m.text),
    stopWithSweep: (id) => { stops.push(id); runtime[id].busy = false; return Promise.resolve('closed Game.exe (42)'); },
    wake: (a, job, why, swept) => wakes.push({ id: a.id, job, why, swept }),
  });

  // 1. Output / tool calls keep a run alive well past the stop limit; true silence does not.
  for (let i = 0; i < 10; i++) { t += 20; runtime.busy1.lastAliveAt = t; wd.tick(); } // 200 ticks-ms of work, limit is 60
  eq('active run not stopped', stops.includes('busy1'), false);
  eq('quiet run stopped', stops, ['quiet1']);
  eq('quiet run warned first', posts.some((p) => /Quiet has been running/.test(p)), true);
  eq('stop line says why', posts.some((p) => /Quiet was stopped: no chat post, tool call or output/.test(p)), true);
  return { out, wd, runtime, wakes, stops, posts, setT: (v) => { t = v; }, getT: () => t };
}

async function run() {
  const x = runTests();
  const { out, wakes, stops } = x;
  const eq = (what, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) out.push(`${what}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
  await new Promise((r) => setImmediate(r));
  // 2. The coordinator is woken once, with agent, job and reason; The owner's own Stop wakes nobody.
  eq('one wake', wakes.length, 1);
  eq('wake agent', wakes[0]?.id, 'quiet1');
  eq('wake job', wakes[0]?.job, 'the job text');
  eq('wake reason', /no chat post, tool call or output/.test(wakes[0]?.why || ''), true);
  eq('wake carries sweep result', wakes[0]?.swept, 'closed Game.exe (42)');
  eq('Owner stop is not touched', stops.includes('owner1'), false);
  // A stopped run is not stopped (or woken) again on later ticks.
  x.setT(x.getT() + 500); x.runtime.busy1.lastAliveAt = x.getT(); x.wd.tick(); await new Promise((r) => setImmediate(r));
  eq('no second wake', wakes.length, 1);

  // 3. Hand-off limit: visible line, one wake, no loop.
  let t = 0;
  const posts = [], w2 = [];
  const notice = createLimitNotice({ post: (m) => posts.push(m.text), wake: (...a) => w2.push(a), now: () => t, cooldownMs: 100 });
  const from = { id: 'webapp', name: 'WebApp' };
  const dropped = [{ id: 'assistant', name: 'Assistant', brief: 'x' }];
  eq('first drop wakes', notice(from, { fromId: 'assistant' }, dropped, 12), true);
  eq('visible line posted', /WebApp's hand-off to Assistant was not delivered/.test(posts[0] || ''), true);
  t = 10;
  eq('repeat inside cooldown does not wake', notice(from, { fromId: 'assistant' }, dropped, 12), false);
  eq('repeat still posts a line', posts.length, 2);
  t = 500;
  eq('a run that was itself a Crew notice never wakes', notice(from, { fromId: 'crew' }, dropped, 12), false);
  eq('after cooldown wakes again', notice(from, { fromId: 'user' }, dropped, 12), true);
  eq('nothing dropped, nothing posted', notice(from, {}, [], 12), false);
  eq('wake count', w2.length, 2);
  return out;
}

module.exports = { run };
if (require.main === module) run().then((o) => { console.log(o.length ? o.join('\n') : 'ok'); process.exit(o.length ? 1 : 0); });
