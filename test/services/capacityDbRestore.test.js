const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const SCRIPT = path.resolve(__dirname, "../../scripts/capacity-db.js");
const PASSWORD = "capacity restore password";
const DATABASE_URL = `postgresql://capacity_restore:${encodeURIComponent(PASSWORD)}@127.0.0.1:5544/capacity_restore_test`;

function installFakePostgresCommand(directory, command) {
  const executable = path.join(directory, command);
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const capture = fs.existsSync(process.env.CAPACITY_DB_CAPTURE)
  ? JSON.parse(fs.readFileSync(process.env.CAPACITY_DB_CAPTURE, "utf8"))
  : [];
capture.push({
  command: path.basename(process.argv[1]),
  args: process.argv.slice(2),
  env: Object.fromEntries(["PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]
    .map((name) => [name, process.env[name]])),
  inheritedDatabaseUrl: Object.hasOwn(process.env, "DATABASE_URL"),
});
fs.writeFileSync(process.env.CAPACITY_DB_CAPTURE, JSON.stringify(capture));
`);
  fs.chmodSync(executable, 0o700);
}

function runRestore(extension) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "capacity-db-restore-"));
  const snapshot = path.join(directory, `snapshot${extension}`);
  const capture = path.join(directory, "capture.json");
  fs.writeFileSync(snapshot, "synthetic snapshot");
  installFakePostgresCommand(directory, "pg_restore");
  installFakePostgresCommand(directory, "psql");
  const result = spawnSync(process.execPath, [SCRIPT, "restore", "--snapshot", snapshot], {
    cwd: path.resolve(__dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      CAPACITY_MODE: "false",
      CAPACITY_DB_CAPTURE: capture,
      DATABASE_URL,
      PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    },
  });
  assert.equal(result.status, 0, "capacity restore CLI should succeed with fake PostgreSQL commands");
  return JSON.parse(fs.readFileSync(capture, "utf8"));
}

for (const [extension, expectedCommands] of [
  [".dump", ["pg_restore"]],
  [".sql", ["psql", "psql"]],
]) {
  test(`capacity DB ${extension} restore keeps connection secrets out of process arguments`, () => {
    const calls = runRestore(extension);
    assert.deepEqual(calls.map((call) => call.command), expectedCommands);
    for (const call of calls) {
      assert.equal(call.args.some((argument) => argument.includes("postgresql://")), false);
      assert.equal(call.args.some((argument) => argument.includes(encodeURIComponent(PASSWORD))), false);
      assert.equal(call.args.some((argument) => argument.includes(PASSWORD)), false);
      assert.equal(call.inheritedDatabaseUrl, false);
      assert.deepEqual(call.env, {
        PGHOST: "127.0.0.1",
        PGPORT: "5544",
        PGUSER: "capacity_restore",
        PGPASSWORD: PASSWORD,
        PGDATABASE: "capacity_restore_test",
      });
      const databaseArgument = call.args.indexOf("--dbname");
      assert.notEqual(databaseArgument, -1);
      assert.equal(call.args[databaseArgument + 1], "capacity_restore_test");
    }
  });
}
