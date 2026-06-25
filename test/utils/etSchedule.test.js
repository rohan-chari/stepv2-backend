const assert = require("node:assert/strict");
const test = require("node:test");

const { etDayKey, etHour, dailyRunKey } = require("../../src/utils/etSchedule");

// 2026-06-25 is EDT (UTC-4). 16:00 ET == 20:00 UTC; 01:00 ET == 05:00 UTC.
test("etDayKey returns the ET calendar day, not the UTC day", () => {
  // 03:30 UTC on the 25th is still 23:30 ET on the 24th.
  assert.equal(etDayKey(new Date("2026-06-25T03:30:00Z")), "2026-06-24");
  assert.equal(etDayKey(new Date("2026-06-25T12:00:00Z")), "2026-06-25");
});

test("etHour returns the wall-clock ET hour", () => {
  assert.equal(etHour(new Date("2026-06-25T20:00:00Z")), 16); // 4pm EDT
  assert.equal(etHour(new Date("2026-06-25T05:00:00Z")), 1); // 1am EDT
});

test("dailyRunKey: fires once at/after the target ET hour when not yet run today", () => {
  const now = new Date("2026-06-25T20:05:00Z"); // 4:05pm ET
  assert.equal(dailyRunKey({ now, targetHour: 16, lastRanFor: null }), "2026-06-25");
  assert.equal(dailyRunKey({ now, targetHour: 16, lastRanFor: "2026-06-24" }), "2026-06-25");
});

test("dailyRunKey: does not fire before the target ET hour", () => {
  const now = new Date("2026-06-25T19:00:00Z"); // 3pm ET
  assert.equal(dailyRunKey({ now, targetHour: 16, lastRanFor: null }), null);
});

test("dailyRunKey: does not re-fire once already run for this ET day", () => {
  const now = new Date("2026-06-25T21:00:00Z"); // 5pm ET, later same day
  assert.equal(dailyRunKey({ now, targetHour: 16, lastRanFor: "2026-06-25" }), null);
});

test("dailyRunKey: a missed boundary self-heals later the same ET day", () => {
  const now = new Date("2026-06-25T23:30:00Z"); // 7:30pm ET, hours after 4pm
  assert.equal(dailyRunKey({ now, targetHour: 16, lastRanFor: "2026-06-24" }), "2026-06-25");
});

test("dailyRunKey: 1am-ET cleanup target", () => {
  const before = new Date("2026-06-25T04:30:00Z"); // 12:30am ET
  const after = new Date("2026-06-25T05:10:00Z"); // 1:10am ET
  assert.equal(dailyRunKey({ now: before, targetHour: 1, lastRanFor: null }), null);
  assert.equal(dailyRunKey({ now: after, targetHour: 1, lastRanFor: null }), "2026-06-25");
});

test("DST: in winter (EST, UTC-5) the ET hour math still holds", () => {
  // 2026-01-15 is EST (UTC-5). 16:00 ET == 21:00 UTC.
  assert.equal(etHour(new Date("2026-01-15T21:00:00Z")), 16);
  assert.equal(etDayKey(new Date("2026-01-15T21:00:00Z")), "2026-01-15");
  assert.equal(
    dailyRunKey({ now: new Date("2026-01-15T21:00:00Z"), targetHour: 16, lastRanFor: null }),
    "2026-01-15"
  );
  // 20:00 UTC is only 3pm EST -> below target, must not fire.
  assert.equal(
    dailyRunKey({ now: new Date("2026-01-15T20:00:00Z"), targetHour: 16, lastRanFor: null }),
    null
  );
});
