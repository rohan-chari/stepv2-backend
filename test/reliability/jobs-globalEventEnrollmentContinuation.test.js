// Pure scheduling ownership cannot be expressed with HTTP clocks. Real database
// lifecycle/fairness/HTTP tests exercise the public controller separately.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { scheduleGlobalStepEvents } = require('../../src/modules/steps/jobs/globalStepEventScheduler');
const turn = () => new Promise(resolve => setImmediate(resolve));
test('end retry and enrollment retry survive independent minute requests with boundary priority', async () => {
  const calls = [], timers = [];
  const controller = {
    async runMinuteMaintenance() { calls.push('minute'); },
    async runEnrollmentSlice() { calls.push('enrollment'); return { more: calls.filter(x => x === 'enrollment').length < 2, retryAfterMs: 250 }; },
  };
  const scheduler = scheduleGlobalStepEvents({ localGlobalStepEventTick: controller,
    maybeStartGlobalEvent: async () => { calls.push('legacy-minute'); },
    endDrain: { async run() { calls.push('end'); return { more: calls.filter(x => x === 'end').length < 2, retryAfterMs: 100 }; } },
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.push(timer); return timer; },
    clearTimeout() {}, nowMs: () => 0, logger: { log() {}, error() {} },
  });
  await turn();
  assert.equal(calls[0], 'end', 'due boundaries precede minute maintenance');
  assert.ok(calls.includes('enrollment'), 'stable enrollment controller receives a slice');
  assert.equal(timers.at(-1).ms, 100, 'earliest end retry survives enrollment retry');
  await scheduler.stop();
});
test('stop during an enrollment write awaits it and admits no next slice', async () => {
  let release, began;
  const started = new Promise(resolve => { began = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  let writes = 0;
  const controller = { async runMinuteMaintenance() {}, async runEnrollmentSlice() {
    writes++; began(); await waiting; return { more: true, retryAfterMs: 1 };
  } };
  const scheduler = scheduleGlobalStepEvents({ localGlobalStepEventTick: controller,
    maybeStartGlobalEvent: async () => {}, endDrain: { async run() { return { more: false }; } },
    logger: { log() {}, error() {} },
  });
  await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error('enrollment was never serviced')), 1000))]);
  let finished = false; const stopping = scheduler.stop().then(() => { finished = true; });
  await turn(); assert.equal(finished, false); release(); await stopping;
  await scheduler.tick(); assert.equal(writes, 1);
});
test('stopping during local maintenance suppresses subsequent legacy boundary and creation writes',async()=>{
  const { buildMaybeStartGlobalEvent }=require('../../src/modules/steps/jobs/globalStepEventScheduler');
  let stopped=false;const calls=[];
  const run=buildMaybeStartGlobalEvent({now:()=>new Date('2026-08-19T00:00:00Z'),
    localGlobalStepEventTick:async()=>{stopped=true;},
    GlobalStepEventBoundaryCursor:{async claim(){calls.push('claim');return null;}},
    GlobalStepEvent:{async findStartedSince(){calls.push('read');return[];}},
    logger:{log(){},error(){}}});
  await run({isStopped:()=>stopped});
  assert.deepEqual(calls,[]);
});
