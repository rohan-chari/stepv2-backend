const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  herdPerDay,
  countCapybaras,
  isCapybara,
  isCorgi,
  raceLocalDayCount,
  computeHerdBonus,
  HERD_DAILY_CAP,
} = require("../../src/modules/races/services/characterPowers");

function withCharacter(assetKey) {
  return { user: { equippedAccessories: assetKey ? [{ slot: "CHARACTER", shopItem: { slot: "CHARACTER", assetKey } }] : [] } };
}

test("herdPerDay: 100 per capy, capped at 1,000 (10 capys)", () => {
  assert.equal(herdPerDay(0), 0);
  assert.equal(herdPerDay(1), 100);
  assert.equal(herdPerDay(3), 300);
  assert.equal(herdPerDay(10), 1000);
  assert.equal(herdPerDay(11), 1000); // cap
  assert.equal(herdPerDay(12), 1000); // cap (§8.5)
  assert.equal(herdPerDay(50), HERD_DAILY_CAP);
});

test("isCapybara: default (no cosmetic) counts as capybara; corgi does not", () => {
  assert.equal(isCapybara(withCharacter(null).user), true);
  assert.equal(isCapybara(withCharacter("capybara_classic").user), true);
  assert.equal(isCapybara(withCharacter("corgi_puppy").user), false);
});

test("isCorgi: only corgi-keyed characters", () => {
  assert.equal(isCorgi(withCharacter("corgi_puppy").user), true);
  assert.equal(isCorgi(withCharacter(null).user), false);
  assert.equal(isCorgi(withCharacter("capybara_classic").user), false);
});

test("countCapybaras counts defaults + explicit capys, excludes corgis", () => {
  const participants = [
    withCharacter(null), // capy
    withCharacter("capybara_classic"), // capy
    withCharacter("corgi_puppy"), // corgi
  ];
  assert.equal(countCapybaras(participants), 2);
});

test("raceLocalDayCount: join day is day 1 (inclusive)", () => {
  const tz = "America/New_York";
  const start = new Date("2026-07-25T15:00:00.000Z"); // 11:00 ET on the 25th
  const sameDay = new Date("2026-07-25T20:00:00.000Z"); // 16:00 ET same day
  assert.equal(raceLocalDayCount({ effectiveStart: start, end: sameDay, timeZone: tz }), 1);
  const threeDays = new Date("2026-07-27T20:00:00.000Z"); // 27th ET
  assert.equal(raceLocalDayCount({ effectiveStart: start, end: threeDays, timeZone: tz }), 3);
});

test("computeHerdBonus: non-capybara earns 0; capybara earns perDay * days", () => {
  const tz = "America/New_York";
  const start = new Date("2026-07-25T15:00:00.000Z");
  const end = new Date("2026-07-26T20:00:00.000Z"); // 2 local days

  const corgi = computeHerdBonus({
    participant: withCharacter("corgi_puppy"),
    capyCount: 3, effectiveStart: start, end, timeZone: tz,
  });
  assert.equal(corgi.bonusSteps, 0);
  assert.equal(corgi.animal, null);

  const capy = computeHerdBonus({
    participant: withCharacter(null),
    capyCount: 3, effectiveStart: start, end, timeZone: tz,
  });
  assert.equal(capy.animal, "capybara");
  assert.equal(capy.perDay, 300);
  assert.equal(capy.bonusSteps, 600); // 300/day * 2 days
});
