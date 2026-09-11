const assert = require("node:assert/strict");
const { beforeEach, it } = require("node:test");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const target = new URL(process.env.DATABASE_URL);
assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
assert.match(decodeURIComponent(target.pathname), /_test$/);
assert.equal(process.env.NODE_ENV, "test");
const { prisma, cleanDatabase } = require("./setup");
beforeEach(cleanDatabase);

it("runs the operator CLI with the explicit one-connection production role against an isolated test database", async () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "receipt-production-cli-"));
  try {
    const base = [path.resolve(__dirname, "../../scripts/discover-domain-event-receipt-recovery.js"),
      "--db=prod", "--cutoff=2026-09-01T00:00:00Z", "--limit=1"];
    const options = { cwd: scratch, encoding: "utf8", timeout: 15000, env: {
      PATH: process.env.PATH, NODE_ENV: "production", REDIS_URL: "",
      // Logical CLI alias only: BOTH URLs are the validated local *_test DB.
      DATABASE_URL: target.toString(), PROD_DATABASE_URL: target.toString(),
      STEPS_PROCESS_ROLE: "cron", DATABASE_POOL_MAX_CRON: "1",
    } };
    const preview = JSON.parse(execFileSync(process.execPath, base, options));
    assert.equal(preview.readOnly, true);
    assert.equal(preview.scanned, 0);
    assert.equal((await prisma.$queryRawUnsafe("SELECT id FROM domain_event_receipt_discovery")).length, 0);
    const applied = JSON.parse(execFileSync(process.execPath, [...base, "--apply"], options));
    assert.equal(applied.readOnly, false);
    assert.equal(applied.deferred, false);
    assert.equal(applied.exhausted, true);
    const states = await prisma.$queryRawUnsafe("SELECT id,completed_at FROM domain_event_receipt_discovery ORDER BY id");
    assert.deepEqual(states.map((row) => row.id), ["automatic-v1", "historical-v1"]);
    assert.equal(states[0].completed_at, null, "manual production-mode CLI does not advance automatic progress");
    assert.ok(states[1].completed_at);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
