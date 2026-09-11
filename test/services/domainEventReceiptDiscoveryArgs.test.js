const assert = require("node:assert/strict");
const { it } = require("node:test");
const { parseArgs } = require("../../scripts/discover-domain-event-receipt-recovery");

it("requires complete, valid discovery cursors so a resumed page cannot skip rows", () => {
  const base = ["--cutoff=2026-09-01T00:00:00Z"];
  assert.throws(() => parseArgs([...base, "--after-created-at=2026-08-01"]), /together/);
  assert.throws(() => parseArgs([...base, "--after-id=00000000-0000-0000-0000-000000000001"]), /together/);
  assert.throws(() => parseArgs([...base, "--after-created-at=2026-08-01", "--after-id=invalid"]), /UUID/);
  const result = parseArgs([...base, "--after-created-at=2026-08-01", "--after-id=00000000-0000-0000-0000-000000000001"]);
  assert.equal(result.apply, false);
  assert.equal(result.limit, 500);
});
