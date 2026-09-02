const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { main } = require("../../../performance/lib/main");

test("main dispatches exact ./perf scan contract with centralized rate override", async () => {
  const calls = [];
  const summary = { safeHomeOpensPerSecond: 20 };
  const result = await main(["scan", "--rates=5,10"], {
    repository: "/tmp/repository",
    loadConfig: ({ mode, overrides }) => (calls.push(["config", mode, overrides]), { mode }),
    createRuntime: () => ({ name: "runtime" }),
    createProvider: ({ adapter }) => (calls.push(["provider", adapter.name]), {}),
    createWorkload: () => ({}),
    runWorkflow: async ({ cli, config }) => (calls.push(["run", cli.command, config.mode]), {
      summary, reportPath: "/tmp/report.md",
    }),
    output: { write: (value) => calls.push(["output", value]) },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls[0], ["config", "scan", { scan: { rates: [5, 10] } }]);
  assert.deepEqual(calls.at(-1), ["output", "Report: /tmp/report.md\n"]);
});

test("unimplemented certification cannot silently fall back to the scan path", async () => {
  await assert.rejects(main(["certify"], { repository: "/tmp/repository" }),
    /not enabled.*first-run/i);
});

test("first-run CLI rejects keep-running before constructing a mutable provider", async () => {
  let providerConstructed = false;
  await assert.rejects(main(["scan", "--keep-running"], {
    repository: "/tmp/repository",
    createProvider: () => { providerConstructed = true; return {}; },
  }), /keep-running.*not enabled.*first-run/i);
  assert.equal(providerConstructed, false);
});

test("main captures termination signals long enough for the workflow to write partial evidence", async () => {
  const signalSource = new EventEmitter();
  const result = await main(["scan"], {
    repository: "/tmp/repository",
    loadConfig: () => ({ mode: "scan" }),
    createRuntime: () => ({}), createProvider: () => ({}), createWorkload: () => ({}),
    signalSource,
    runWorkflow: async ({ getInterruption }) => {
      signalSource.emit("SIGTERM");
      assert.equal(getInterruption(), "SIGTERM");
      return { failed: true, summary: { status: "failed" }, reportPath: "/tmp/partial.md" };
    },
    output: { write: () => {} },
  });
  assert.equal(result.exitCode, 2);
  assert.equal(signalSource.listenerCount("SIGINT"), 0);
  assert.equal(signalSource.listenerCount("SIGTERM"), 0);
});
