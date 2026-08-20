const assert = require("node:assert/strict");
const test = require("node:test");

const { runAfterCommitTasks } = require("../../src/db");

test("postcommit callbacks are isolated so one notification failure cannot reject a committed command", async () => {
  const calls = [];
  const errors = [];
  await runAfterCommitTasks([
    async () => { calls.push("first"); throw new Error("notification failed"); },
    async () => { calls.push("second"); },
  ], {
    error(message, error) { errors.push([message, error.message]); },
  });
  assert.deepEqual(calls, ["first", "second"]);
  assert.deepEqual(errors, [["[DB] postcommit callback failed", "notification failed"]]);
});
