// Protocol/config plumbing is not observable in an HTTP response. Real HTTP and
// worker parity are covered separately through the local transaction pool.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { installPreparedReadQueries } = require('../../src/shared/database/preparedReadQueries');
function fixture() {
  const pool = new EventEmitter();
  installPreparedReadQueries(pool);
  const calls = [];
  const client = { query(...args) { calls.push(args); return 'result'; } };
  pool.emit('connect', client);
  return { pool, client, calls };
}
const text = '/* steps:prepared-read:v1 */ SELECT $1::text AS value';
test('names marked queries by SQL, preserving values/types/callback and caller config', () => {
  const { client, calls } = fixture();
  const types = {}; const cb = () => {};
  const q = { text, values: ['one'], rowMode: 'array', types };
  assert.equal(client.query(q, cb), 'result');
  client.query({ ...q, values: ['two'] });
  assert.equal(q.name, undefined);
  assert.match(calls[0][0].name, /^steps_read_v1_[a-f0-9]{48}$/);
  assert.equal(calls[0][0].name, calls[1][0].name);
  assert.equal(calls[0][0].types, types);
  assert.equal(calls[0][1], cb);
  assert.deepEqual(calls[1][0].values, ['two']);
});
test('leaves unmarked statements, named statements, and string overloads alone', () => {
  const { client, calls } = fixture();
  for (const q of ['BEGIN', { text: 'SELECT $1', values: [1] },
    { text, name: 'caller-owned', values: [1] }]) {
    client.query(q); assert.equal(calls.at(-1)[0], q);
  }
});
test('bounds SQL names at 128 per pool and keeps existing names after overflow', () => {
  const { client, calls, pool } = fixture();
  for (let i = 0; i < 129; i++) client.query({ text: text + ' /*' + i + '*/', values: ['x'] });
  assert.ok(calls[127][0].name);
  assert.equal(calls[128][0].name, undefined);
  client.query({ text: text + ' /*0*/', values: ['y'] });
  assert.equal(calls.at(-1)[0].name, calls[0][0].name);
  const replacement = { query(q) { return q; } };
  pool.emit('connect', replacement);
  assert.equal(replacement.query({ text: text + ' /*0*/' }).name, calls[0][0].name);
});
test('propagates query failures without automatic replay', async () => {
  const pool = new EventEmitter(); installPreparedReadQueries(pool);
  const error = new Error('transaction aborted'); let attempts = 0;
  const client = { query() { attempts++; return Promise.reject(error); } };
  pool.emit('connect', client);
  await assert.rejects(client.query({ text, values: ['x'] }), error);
  assert.equal(attempts, 1);
});

test('selected queue writes reuse names and never replay an aborted transaction', async () => {
  const { client, calls } = fixture();
  const text = '/* steps:prepared-query:v1 */ UPDATE queue SET lease_token=$1 WHERE id=$2 RETURNING id';
  client.query({ text, values: ['first-token', 1] });
  client.query({ text, values: ['second-token', 2] });
  assert.match(calls[0][0].name, /^steps_query_v1_[a-f0-9]{48}$/);
  assert.equal(calls[0][0].name, calls[1][0].name);
  assert.deepEqual(calls[1][0].values, ['second-token', 2]);
  const pool = new EventEmitter();
  installPreparedReadQueries(pool);
  const error = Object.assign(new Error('transaction aborted'), { code: '40001' });
  let attempts = 0;
  const failing = { query() { attempts++; return Promise.reject(error); } };
  pool.emit('connect', failing);
  await assert.rejects(failing.query({ text, values: ['token', 1] }), error);
  assert.equal(attempts, 1);
});
