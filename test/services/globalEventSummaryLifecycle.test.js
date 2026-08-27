const assert = require("node:assert/strict");
const test = require("node:test");

const {
  computeSummaryExpiresAt,
} = require("../../src/modules/steps/services/globalEventSummaryLifecycle");

test("summary expiry is the next civil midnight across ordinary and DST days", () => {
  assert.equal(
    computeSummaryExpiresAt({ localDate: "2026-08-26", timezone: "America/New_York" }).toISOString(),
    "2026-08-27T04:00:00.000Z",
  );
  assert.equal(
    computeSummaryExpiresAt({ localDate: "2026-03-07", timezone: "America/New_York" }).toISOString(),
    "2026-03-08T05:00:00.000Z",
  );
  assert.equal(
    computeSummaryExpiresAt({ localDate: "2026-11-01", timezone: "America/New_York" }).toISOString(),
    "2026-11-02T05:00:00.000Z",
  );
});

test("summary expiry fails closed for malformed dates and untrusted timezones", () => {
  for (const input of [
    { localDate: "2026-02-30", timezone: "America/New_York" },
    { localDate: "2026-08-26", timezone: "Not/A_Zone" },
    { localDate: null, timezone: "America/New_York" },
  ]) {
    assert.equal(computeSummaryExpiresAt(input), null);
  }
});
