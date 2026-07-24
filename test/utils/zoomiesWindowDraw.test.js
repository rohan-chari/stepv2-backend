const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  drawZoomiesStartMinutes,
  ZOOMIES_DAY_START_MIN,
  ZOOMIES_DAY_END_MIN,
  ZOOMIES_WINDOW_LEN_MIN,
  ZOOMIES_MIN_GAP_MIN,
} = require("../../src/modules/races/services/characterPowers");

const LATEST_START = ZOOMIES_DAY_END_MIN - ZOOMIES_WINDOW_LEN_MIN; // 1310

test("draw is deterministic per (user, day)", () => {
  const a = drawZoomiesStartMinutes("user-abc", "2026-07-25");
  const b = drawZoomiesStartMinutes("user-abc", "2026-07-25");
  assert.deepEqual(a, b);
});

test("different user or day yields (generally) different draws", () => {
  const base = drawZoomiesStartMinutes("user-abc", "2026-07-25");
  const otherUser = drawZoomiesStartMinutes("user-xyz", "2026-07-25");
  const otherDay = drawZoomiesStartMinutes("user-abc", "2026-07-26");
  assert.ok(
    JSON.stringify(base) !== JSON.stringify(otherUser) ||
      JSON.stringify(base) !== JSON.stringify(otherDay),
    "seed should vary the draw across users/days"
  );
});

test("both windows inside [08:00, 22:00), earlier first, >= 2h apart — over many users", () => {
  for (let i = 0; i < 2000; i++) {
    const userId = `user-${i}`;
    const day = "2026-07-25";
    const [a, b] = drawZoomiesStartMinutes(userId, day);

    assert.ok(a >= ZOOMIES_DAY_START_MIN, `slot0 start >= 08:00 (${a})`);
    assert.ok(a <= LATEST_START, `slot0 window ends by 22:00 (${a})`);
    assert.ok(b >= ZOOMIES_DAY_START_MIN, `slot1 start >= 08:00 (${b})`);
    assert.ok(b <= LATEST_START, `slot1 window ends by 22:00 (${b})`);
    assert.ok(b - a >= ZOOMIES_MIN_GAP_MIN, `>= 2h apart (${a}, ${b})`);
    assert.ok(a < b, "earlier window first");
  }
});

test("injectable pickInt forces exact draws", () => {
  // pickInt always returns 0 => a = 08:00 (480), b = a + gap = 10:00 (600).
  const [a, b] = drawZoomiesStartMinutes("u", "d", () => 0);
  assert.equal(a, ZOOMIES_DAY_START_MIN);
  assert.equal(b, ZOOMIES_DAY_START_MIN + ZOOMIES_MIN_GAP_MIN);
});
