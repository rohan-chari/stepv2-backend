const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { before, beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, getSharedServer, prisma, request } = require("./setup");
const run = promisify(execFile);
let server;

describe("existing manual goodwill grant command", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(cleanDatabase);
  it("previews without writing and concurrent retries credit exactly +500 through the audited seam", async () => {
    const { user, token } = await createTestUser({ displayName: "LocalGoodwillFixture", coins: 123 });
    const args = ["scripts/grant-coins-manual.js", "--user", user.id, "--amount", "500", "--ref", "red-card-goodwill-2026-09-10"];
    const preview = await run(process.execPath, args, { env: process.env });
    assert.match(preview.stdout, /DRY RUN/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).coins, 123);
    assert.equal(await prisma.coinTransaction.count({ where: { userId: user.id } }), 0);
    const results = await Promise.all([run(process.execPath, [...args, "--apply"], { env: process.env }), run(process.execPath, [...args, "--apply"], { env: process.env })]);
    assert.equal(results.filter(r => /APPLIED:/.test(r.stdout)).length, 1);
    assert.equal(results.filter(r => /SKIPPED/.test(r.stdout)).length, 1);
    const res = await request(server.baseUrl, "GET", "/auth/me", { token, headers: { "X-Client-Features": "characters" } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.coins, 623);
    const ledger = await prisma.coinTransaction.findMany({ where: { userId: user.id, reason: "admin_grant", refId: "red-card-goodwill-2026-09-10" } });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, 500);
    assert.equal(await prisma.inboxAlert.count({ where: { userId: user.id } }), 0);
  });
});
