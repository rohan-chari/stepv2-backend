const assert = require("node:assert/strict");
const test = require("node:test");

const { startServer } = require("../../src/index");

test("startServer listens on 0.0.0.0 by default", () => {
  let listenArgs;
  let registerCalls = 0;
  let scheduleCalls = 0;
  const logs = [];
  const server = { close() {} };

  const app = {
    listen(...args) {
      listenArgs = args;
      const onListening = args[2];
      onListening();
      return server;
    },
  };

  const startedServer = startServer({
    app,
    port: 3000,
    registerEventHandlers() {
      registerCalls += 1;
    },
    scheduleCronJobs() {
      scheduleCalls += 1;
    },
    logger: {
      log(message) {
        logs.push(message);
      },
    },
  });

  assert.equal(startedServer, server);
  assert.deepEqual(listenArgs.slice(0, 2), [3000, "0.0.0.0"]);
  assert.equal(registerCalls, 1);
  assert.equal(scheduleCalls, 1);
  assert.deepEqual(logs, ["Steps Tracker API running on 0.0.0.0:3000"]);
});
