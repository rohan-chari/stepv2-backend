const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chooseLocalStartMinute,
  localEventWindowForZone,
  compatibilityEnvelopeForLocalEvent,
  GLOBAL_EVENT_DURATION_MS,
} = require("../../src/modules/steps/globalStepEvent");

test("one injected logical-day draw is reused across timezones", () => {
  let draws = 0;
  const minute = chooseLocalStartMinute({
    randomInt(min, max) {
      draws += 1;
      assert.equal(min, 8 * 60);
      assert.equal(max, 22 * 60);
      return 17 * 60 + 17;
    },
  });

  assert.equal(draws, 1);
  assert.equal(minute, 17 * 60 + 17);

  const ny = localEventWindowForZone({
    eventDay: "2026-08-20",
    localStartMinute: minute,
    durationMinutes: 30,
    timeZone: "America/New_York",
  });
  const madrid = localEventWindowForZone({
    eventDay: "2026-08-20",
    localStartMinute: minute,
    durationMinutes: 30,
    timeZone: "Europe/Madrid",
  });

  assert.equal(ny.startsAt.toISOString(), "2026-08-20T21:17:00.000Z");
  assert.equal(madrid.startsAt.toISOString(), "2026-08-20T15:17:00.000Z");
  assert.equal(ny.endsAt.getTime() - ny.startsAt.getTime(), GLOBAL_EVENT_DURATION_MS);
  assert.equal(madrid.localDate, "2026-08-20");
});

test("compatibility envelope covers UTC+14 through UTC-12 without changing local dates", () => {
  const envelope = compatibilityEnvelopeForLocalEvent({
    eventDay: "2026-08-20",
    localStartMinute: 17 * 60 + 17,
    durationMinutes: 30,
    timeZones: ["Pacific/Kiritimati", "Etc/GMT+12"],
  });

  assert.equal(envelope.startsAt.toISOString(), "2026-08-20T03:17:00.000Z");
  assert.equal(envelope.endsAt.toISOString(), "2026-08-21T05:47:00.000Z");
});

test("local conversion is DST-safe across 23-hour and 25-hour days", () => {
  const springBefore = localEventWindowForZone({
    eventDay: "2026-03-07", localStartMinute: 17 * 60 + 17,
    durationMinutes: 30, timeZone: "America/New_York",
  });
  const springAfter = localEventWindowForZone({
    eventDay: "2026-03-08", localStartMinute: 17 * 60 + 17,
    durationMinutes: 30, timeZone: "America/New_York",
  });
  assert.equal(springAfter.startsAt - springBefore.startsAt, 23 * 60 * 60 * 1000);

  const fallBefore = localEventWindowForZone({
    eventDay: "2026-10-31", localStartMinute: 17 * 60 + 17,
    durationMinutes: 30, timeZone: "America/New_York",
  });
  const fallAfter = localEventWindowForZone({
    eventDay: "2026-11-01", localStartMinute: 17 * 60 + 17,
    durationMinutes: 30, timeZone: "America/New_York",
  });
  assert.equal(fallAfter.startsAt - fallBefore.startsAt, 25 * 60 * 60 * 1000);
});

test("local schedule validation rejects invalid parent inputs", () => {
  assert.throws(() => localEventWindowForZone({
    eventDay: "not-a-day", localStartMinute: 1000,
    durationMinutes: 30, timeZone: "America/New_York",
  }), /eventDay/);
  assert.throws(() => localEventWindowForZone({
    eventDay: "2026-08-20", localStartMinute: 479,
    durationMinutes: 30, timeZone: "America/New_York",
  }), /localStartMinute/);
  assert.throws(() => localEventWindowForZone({
    eventDay: "2026-08-20", localStartMinute: 1000,
    durationMinutes: 0, timeZone: "America/New_York",
  }), /durationMinutes/);
});
