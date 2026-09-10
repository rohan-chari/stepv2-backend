// Local-test observation only. Run the unchanged src/index.js entrypoint.
process.env.PRISMA_QUERY_EVENTS_ENABLED = 'true';
const { createHash } = require('node:crypto');
const { prisma } = require('../../../../src/db');
const { eventSurgeTelemetry } = require('../../../../src/shared/observability/eventSurgeTelemetry');
const admission = { admitted: 0, rejected: 0 };
const record = eventSurgeTelemetry.recordStepAdmission.bind(eventSurgeTelemetry);
eventSurgeTelemetry.recordStepAdmission = value => { if (Object.hasOwn(admission, value.outcome)) admission[value.outcome]++; return record(value); };
let calls = 0; let elapsedMs = 0; const shapes = new Map();
const sampleBounds = new Map();
prisma.$on('query', event => {
  calls++; elapsedMs += event.duration;
  const text = event.query.replace(/\s+/g, ' ').trim();
  const id = createHash('sha256').update(text).digest('hex').slice(0, 16);
  const row = shapes.get(id) || { id, query: text, calls: 0, elapsedMs: 0 };
  row.calls++; row.elapsedMs += event.duration; shapes.set(id, row);
  if (text.includes('JOIN step_samples sample') && text.includes('requested.ordinal')) {
    for (const bound of JSON.parse(JSON.parse(event.params)[0])) {
      const key = createHash('sha256').update(JSON.stringify([bound.user_id, bound.range_start, bound.range_end])).digest('hex');
      sampleBounds.set(key, (sampleBounds.get(key) || 0) + 1);
    }
  }
});
process.on('message', message => {
  if (message?.kind !== 'cpu-accounting-snapshot') return;
  process.send?.({ kind: 'cpu-accounting-snapshot', requestId: message.requestId,
    calls, elapsedMs, admission: { ...admission }, shapes: [...shapes.values()],
    sampleRangeReads: [...sampleBounds.values()].reduce((sum, n) => sum + n, 0),
    uniqueSampleRanges: sampleBounds.size, processCpu: process.cpuUsage() });
});
