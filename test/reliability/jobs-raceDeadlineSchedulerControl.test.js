const assert = require('node:assert/strict');
const { test } = require('node:test');
// Pure timer/ownership tests: real DB + HTTP behavior lives in integration suite.
const { scheduleRaceEffectDeadlineScheduler } = require('../../src/modules/races/jobs/raceEffectDeadlineScheduler');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let n=0;n<12;n++) await Promise.resolve(); };
function harness(scheduler) {
  let handler;
  const intervals = new Map(), immediates = new Set();
  const controller = scheduleRaceEffectDeadlineScheduler({ scheduler,
    setInterval(fn, ms) { const h = { fn, unref() {} }; intervals.set(ms,h); return h; },
    clearInterval(h) { for (const [ms,v] of intervals) if(v===h) intervals.delete(ms); },
    setImmediate(fn) { const h={ fn, unref() {} }; immediates.add(h); return h; },
    clearImmediate(h) { immediates.delete(h); },
    subscribeDurableQueueWakeup: async fn => { handler=fn; return async()=>{handler=null;}; },
    logger: { error() {} },
  });
  return { controller, intervals,
    wake() { handler?.({queue:'resolution'}); },
    async flush() { for(const h of [...immediates]) {immediates.delete(h);h.fn();} await settle(); },
    pending: () => immediates.size };
}
test('stop waits for both tick and startup recovery, cancels future work', async()=>{
  const t=deferred(), r=deferred();let tick=0,recover=0;
  const h=harness({tick:async()=>{tick++;await t.promise;},recover:async()=>{recover++;await r.promise;}});
  await settle(); assert.equal(tick,1);assert.equal(recover,1);
  let stopped=false;const stop=h.controller.stop().then(()=>{stopped=true;});
  await settle();assert.equal(stopped,false);t.resolve();await settle();assert.equal(stopped,false);
  r.resolve();await stop;h.wake();await h.flush();assert.equal(tick,1);assert.equal(recover,1);assert.equal(h.intervals.size,0);
});
test('wakes during a pass are merged into one nonoverlapping follow-up', async()=>{
  const gate=deferred();let ticks=0,active=0,max=0;
  const h=harness({tick:async()=>{ticks++;active++;max=Math.max(max,active);if(ticks===1)await gate.promise;active--;},recover:async()=>{}});
  await settle();for(let n=0;n<500;n++)h.wake();assert.equal(ticks,1);
  gate.resolve();await settle();assert.equal(h.pending(),1);await h.flush();assert.equal(ticks,2);assert.equal(max,1);
  await h.flush();assert.equal(ticks,2);await h.controller.stop();
});
test('same-turn idle wake burst creates one pass and stop cancels pending immediate', async()=>{
  let ticks=0;const h=harness({tick:async()=>{ticks++;},recover:async()=>{}});
  await settle();for(let n=0;n<100;n++)h.wake();assert.equal(h.pending(),1);
  await h.flush();assert.equal(ticks,2);h.wake();await h.controller.stop();await h.flush();assert.equal(ticks,2);
});
test('five-minute recoveries serialize with one retained request', async()=>{
  const gate=deferred();let recoveries=0,active=0,max=0;
  const h=harness({tick:async()=>{},recover:async()=>{recoveries++;active++;max=Math.max(max,active);if(recoveries===1)await gate.promise;active--;}});
  await settle();for(let n=0;n<20;n++)h.intervals.get(300000).fn();
  assert.equal(recoveries,1);gate.resolve();await settle();await h.flush();assert.equal(recoveries,2);assert.equal(max,1);await h.controller.stop();
});
test('failed pass releases ownership and next timer can retry', async()=>{
  let ticks=0;const h=harness({tick:async()=>{if(++ticks===1)throw new Error('test failure');},recover:async()=>{}});
  await settle();h.intervals.get(1000).fn();await h.flush();assert.equal(ticks,2);await h.controller.stop();
});
