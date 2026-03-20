const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getChallengeEndsAtForWeek,
  getChallengeSyncDaysForWeek,
} = require("../../src/utils/week");

test("getChallengeSyncDaysForWeek returns New York challenge-day intervals through today", () => {
  const syncDays = getChallengeSyncDaysForWeek(
    "2026-03-16",
    new Date("2026-03-19T15:30:00.000Z")
  );

  assert.deepEqual(syncDays, [
    {
      date: "2026-03-16",
      startsAt: "2026-03-16T04:00:00.000Z",
      endsAt: "2026-03-17T04:00:00.000Z",
    },
    {
      date: "2026-03-17",
      startsAt: "2026-03-17T04:00:00.000Z",
      endsAt: "2026-03-18T04:00:00.000Z",
    },
    {
      date: "2026-03-18",
      startsAt: "2026-03-18T04:00:00.000Z",
      endsAt: "2026-03-19T04:00:00.000Z",
    },
    {
      date: "2026-03-19",
      startsAt: "2026-03-19T04:00:00.000Z",
      endsAt: "2026-03-19T15:30:00.000Z",
    },
  ]);
});

test("getChallengeSyncDaysForWeek returns an empty list before the challenge week starts", () => {
  const syncDays = getChallengeSyncDaysForWeek(
    "2026-03-16",
    new Date("2026-03-15T18:00:00.000Z")
  );

  assert.deepEqual(syncDays, []);
});

test("getChallengeEndsAtForWeek returns Sunday 11:59 PM New York as UTC", () => {
  assert.equal(
    getChallengeEndsAtForWeek("2026-03-16"),
    "2026-03-23T03:59:00.000Z"
  );
});
