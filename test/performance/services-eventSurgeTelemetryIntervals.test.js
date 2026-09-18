const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const express = require('express');
const { createEventSurgeTelemetry } = require('../../src/shared/observability/eventSurgeTelemetry');

function harness(start = '2098-08-26T10:00:15.000Z', publish) {
  let current = Date.parse(start);
  const timers = new Set();
  const logs = [];
  const telemetry = createEventSurgeTelemetry({
    role: "http", instance: "0", nowMs: () => current,
    logger: { log: line => logs.push(JSON.parse(line)) },
    redisCache: { setJSON: publish || (async () => true) },
    setTimer(fn, delay) { const timer = { fn, delay, unref() {} }; timers.add(timer); return timer; },
    clearTimer(timer) { timers.delete(timer); },
  });
  return { telemetry, logs, timers,
    set(value) { current = Date.parse(value); },
    async fire(value) {
      current = Date.parse(value);
      assert.equal(timers.size, 1);
      const timer = [...timers][0]; timers.delete(timer);
      await timer.fn();
    },
  };
}
const record = telemetry => telemetry.recordHttpRequest({ path: '/auth/me', status: 200 });

test('early timer keeps counts until its scheduled deadline and emits one interval', async () => {
  const h = harness(); h.telemetry.start(); record(h.telemetry);
  await h.fire('2098-08-26T10:00:59.999Z');
  assert.equal(h.logs.length, 0, 'early callback must not flush or relabel counts');
  assert.equal([...h.timers][0].delay, 1);
  await h.fire('2098-08-26T10:01:00.000Z');
  assert.equal(h.logs.length, 1);
  const row = h.logs[0];
  assert.equal(row.minuteStartedAt, '2098-08-26T10:00:00.000Z');
  assert.equal(row.intervalStartedAt, '2098-08-26T10:00:15.000Z');
  assert.equal(row.intervalEndedAt, '2098-08-26T10:01:00.000Z');
  assert.equal(row.scheduledDeadlineAt, '2098-08-26T10:01:00.000Z');
  assert.equal(row.intervalDurationMs, 45000);
  assert.equal(row.http.other.requests, 1);
  await h.fire('2098-08-26T10:02:00.000Z');
  assert.equal(h.logs.length, 2, 'empty traffic still emits exactly one interval');
  assert.equal(h.logs[1].http.other.requests, 0);
  assert.notEqual(h.logs[1].intervalId, row.intervalId);
  h.telemetry.stop(); assert.equal(h.timers.size, 0);
});

test('delayed callback reports actual accumulated interval without invented minute splits', async () => {
  const h = harness('2098-08-26T10:00:00.000Z'); h.telemetry.start(); record(h.telemetry);
  await h.fire('2098-08-26T10:03:05.000Z');
  const row = h.logs[0];
  assert.equal(row.intervalDurationMs, 185000);
  assert.equal(row.intervalStartedAt, '2098-08-26T10:00:00.000Z');
  assert.equal(row.intervalEndedAt, '2098-08-26T10:03:05.000Z');
  assert.equal(row.scheduledDeadlineAt, '2098-08-26T10:01:00.000Z');
  assert.equal(row.minuteStartedAt, '2098-08-26T10:00:00.000Z');
  assert.equal(h.logs.length, 1); assert.equal([...h.timers][0].delay, 55000);
  h.telemetry.stop();
});

test('manual flush owns a partial interval and scheduled flush only owns subsequent requests', async () => {
  const h = harness(); h.telemetry.start(); record(h.telemetry);
  h.set('2098-08-26T10:00:30.000Z'); const partial = await h.telemetry.flush();
  assert.equal(partial.intervalDurationMs, 15000);
  record(h.telemetry);
  await h.fire('2098-08-26T10:01:00.000Z');
  assert.equal(h.logs[1].intervalStartedAt, partial.intervalEndedAt);
  assert.equal(h.logs.reduce((sum, row) => sum + row.http.other.requests, 0), 2);
  h.telemetry.stop();
});

test('state detaches before asynchronous publication; failure and stop preserve subsequent counts', async () => {
  let finish;
  const h = harness(undefined, () => new Promise(resolve => { finish = resolve; }));
  h.telemetry.start(); record(h.telemetry);
  const pending = h.fire('2098-08-26T10:01:00.000Z');
  record(h.telemetry); h.telemetry.stop(); finish(false); await pending;
  assert.equal(h.timers.size, 0, 'stopped telemetry must not re-arm after publication');
  h.set('2098-08-26T10:01:10.000Z');
  const second = h.telemetry.flush(); finish(false); const row = await second;
  assert.equal(row.intervalStartedAt, '2098-08-26T10:01:00.000Z');
  assert.equal(row.http.other.requests, 1);
  assert.equal(h.logs[0].http.other.requests, 1);
});

test('publication failure does not reset interval identity or duplicate counts', async () => {
  const h = harness(undefined, async () => { throw Error('offline'); }); h.telemetry.start();
  record(h.telemetry); await h.fire('2098-08-26T10:01:00.000Z');
  await h.fire('2098-08-26T10:02:00.000Z');
  assert.equal(h.logs.length, 2);
  assert.equal(h.logs[1].intervalStartedAt, h.logs[0].intervalEndedAt);
  assert.equal(h.logs.reduce((sum, row) => sum + row.http.other.requests, 0), 1);
  h.telemetry.stop();
});

test('real HTTP response is counted exactly once across an early and on-time callback', async () => {
  const h = harness(); const middleware = h.telemetry.middleware();
  const app = express(); app.use(middleware); app.get('/auth/me', (req, res) => res.send('ok'));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    h.telemetry.start();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/auth/me`);
    assert.equal(await response.text(), 'ok');
    await h.fire('2098-08-26T10:00:59.999Z');
    await h.fire('2098-08-26T10:01:00.000Z');
    assert.equal(h.logs.length, 1);
    assert.equal(h.logs[0].http.endpointFanout['GET /auth/me'], 1);
    assert.equal(h.logs[0].http.interactive.successes, 1);
  } finally { h.telemetry.stop(); await new Promise(resolve => server.close(resolve)); }
});
