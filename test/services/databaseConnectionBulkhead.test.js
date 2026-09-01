const assert = require("node:assert/strict");
const test = require("node:test");
const { createDatabaseConnectionBulkhead } = require("../../src/shared/database/databaseConnectionBulkhead");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("step traffic cannot consume the four reserved read connections", async () => {
  const clients = [];
  const connect = async () => {
    const client = { release() {} };
    clients.push(client);
    return client;
  };
  let step = true;
  const bulkhead = createDatabaseConnectionBulkhead({
    connect, maximum: 10, maximumStep: 6, isStep: () => step,
  });
  const stepClients = await Promise.all(Array.from({ length: 6 }, () => bulkhead.connect()));
  const seventhStep = bulkhead.connect();
  step = false;
  const readClients = await Promise.all(Array.from({ length: 4 }, () => bulkhead.connect()));
  assert.deepEqual(bulkhead.snapshot(), { active: 10, activeStep: 6, queued: 1, queuedStep: 1 });
  readClients[0].release();
  let seventhResolved = false;
  seventhStep.then(() => { seventhResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(seventhResolved, false);
  stepClients[0].release();
  const seventh = await seventhStep;
  assert.equal(bulkhead.snapshot().activeStep, 6);
  seventh.release();
  [...stepClients.slice(1), readClients[1]].forEach((client) => client.release());
});

test("idle reserved capacity is lent to reads and a waiting step gets the next release", async () => {
  const connect = async () => ({ release() {} });
  let step = false;
  const bulkhead = createDatabaseConnectionBulkhead({
    connect, maximum: 3, maximumStep: 2, isStep: () => step,
  });
  const reads = await Promise.all([bulkhead.connect(), bulkhead.connect(), bulkhead.connect()]);
  step = true;
  const waitingStep = bulkhead.connect();
  step = false;
  const waitingRead = bulkhead.connect();
  reads[0].release();
  const admittedStep = await waitingStep;
  let readResolved = false;
  waitingRead.then(() => { readResolved = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readResolved, false);
  reads[1].release();
  const admittedRead = await waitingRead;
  admittedStep.release(); admittedRead.release(); reads[2].release();
});

test("callback callers retain pg connect semantics", async () => {
  const gate = deferred();
  const connect = async () => { await gate.promise; return { id: 1, release() {} }; };
  const bulkhead = createDatabaseConnectionBulkhead({ connect, maximum: 1, maximumStep: 1 });
  const result = new Promise((resolve, reject) => bulkhead.connect((error, client, release) =>
    error ? reject(error) : resolve({ client, release })));
  gate.resolve();
  const { client, release } = await result;
  assert.equal(client.id, 1);
  assert.equal(bulkhead.snapshot().active, 1);
  release();
  assert.equal(bulkhead.snapshot().active, 0);
});
