const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const database = new URL(process.env.DATABASE_URL || 'postgresql://invalid/unsafe');
assert.ok(['localhost', '127.0.0.1'].includes(database.hostname) && database.pathname.endsWith('_test'));
assert.ok(process.env.REDIS_TEST_URL && ['localhost', '127.0.0.1'].includes(new URL(process.env.REDIS_TEST_URL).hostname));
test('2,000 real HTTP step writes drain every bounded promotion batch and preserve all participant totals', { timeout: 180000 }, async () => {
  const evidence = process.env.CACHE_TEST_EVIDENCE_PATH || path.join(os.tmpdir(), `cache-efficiency-burst-${randomUUID()}.json`);
  const child = spawn(process.execPath, ['test/integration/helpers/burstCacheEfficiency.js'], {
    cwd: process.cwd(), env: { ...process.env, CACHE_TEST_EVIDENCE_PATH: evidence }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { output += bytes; });
  const [code] = await once(child, 'exit');
  assert.equal(code, 0, output);
  const result = JSON.parse(await fs.readFile(evidence, 'utf8'));
  assert.equal(result.successfulWrites, 2000);
  assert.equal(result.durableSteps, 12000000);
  assert.equal(result.resolvedParticipantSteps, 12000000);
  assert.equal(result.durableQueueRows, 1);
  assert.equal(result.requestedGeneration, result.committedGeneration);
  assert.ok(result.committedGeneration > 1, 'the real worker must process successive bounded batches');
});
