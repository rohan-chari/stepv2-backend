const assert = require("node:assert/strict");
const test = require("node:test");

const {
  chooseLocalStartMinute,
  localEventWindowForZone,
  compatibilityEnvelopeForLocalEvent,
  GLOBAL_EVENT_DURATION_MS,
  LOCAL_EVENT_SCHEDULE_V2_BANDS,
  LOCAL_EVENT_SCHEDULE_V2_TOTAL_TICKETS,
  LOCAL_EVENT_SCHEDULE_POLICY_VERSION,
} = require("../../src/modules/steps/globalStepEvent");

const EXPECTED_BANDS = [
  { startMinute: 480, endMinute: 720, tickets: 10800, ticketsPerMinute: 45 },
  { startMinute: 720, endMinute: 900, tickets: 12960, ticketsPerMinute: 72 },
  { startMinute: 900, endMinute: 1020, tickets: 12960, ticketsPerMinute: 108 },
  { startMinute: 1020, endMinute: 1140, tickets: 15120, ticketsPerMinute: 126 },
  { startMinute: 1140, endMinute: 1260, tickets: 15120, ticketsPerMinute: 126 },
  { startMinute: 1260, endMinute: 1320, tickets: 5040, ticketsPerMinute: 84 },
];

test("weighted local schedule constants are immutable and versioned", () => {
  assert.equal(LOCAL_EVENT_SCHEDULE_V2_TOTAL_TICKETS, 72000);
  assert.equal(LOCAL_EVENT_SCHEDULE_POLICY_VERSION, 2);
  assert.ok(Object.isFrozen(LOCAL_EVENT_SCHEDULE_V2_BANDS));
  assert.ok(LOCAL_EVENT_SCHEDULE_V2_BANDS.every(Object.isFrozen));
});

test("all 72,000 tickets produce the exact six-band distribution and uniform minutes", () => {
  const minuteCounts = new Map();
  for (let ticket = 0; ticket < 72000; ticket += 1) {
    const minute = chooseLocalStartMinute({ randomInt: () => ticket });
    minuteCounts.set(minute, (minuteCounts.get(minute) || 0) + 1);
  }

  assert.equal(minuteCounts.size, 840);
  for (const band of EXPECTED_BANDS) {
    let bandTickets = 0;
    for (let minute = band.startMinute; minute < band.endMinute; minute += 1) {
      assert.equal(minuteCounts.get(minute), band.ticketsPerMinute);
      bandTickets += minuteCounts.get(minute);
    }
    assert.equal(bandTickets, band.tickets);
  }
});

test("weighted ticket boundaries map to the exact approved local minutes", () => {
  const expectations = new Map([
    [0, 480], [10799, 719], [10800, 720], [23759, 899],
    [23760, 900], [36719, 1019], [36720, 1020], [51839, 1139],
    [51840, 1140], [66959, 1259], [66960, 1260], [71999, 1319],
  ]);
  for (const [ticket, minute] of expectations) {
    assert.equal(chooseLocalStartMinute({ randomInt: () => ticket }), minute);
  }
});

test("the weighted schedule makes exactly one cryptographic ticket draw", () => {
  let draws = 0;
  const minute = chooseLocalStartMinute({
    randomInt(min, max) {
      draws += 1;
      assert.equal(min, 0);
      assert.equal(max, 72000);
      return 66960;
    },
  });
  assert.equal(draws, 1);
  assert.equal(minute, 1260);
});

test("the weighted schedule rejects invalid injected ticket values", () => {
  for (const ticket of [-1, 72000, 1.5, Number.NaN]) {
    assert.throws(
      () => chooseLocalStartMinute({ randomInt: () => ticket }),
      /ticket.*integer.*\[0, 72000\)/i
    );
  }
});

test("one injected logical-day draw is reused across timezones", () => {
  let draws = 0;
  const minute = chooseLocalStartMinute({
    randomInt(min, max) {
      draws += 1;
      assert.equal(min, 0);
      assert.equal(max, 72000);
      return 38862;
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
