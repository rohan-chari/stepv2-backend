const assert = require("node:assert/strict");
const { describe, it } = require("node:test");

const {
  buildRecentReferrals,
} = require("../../src/modules/giveaways/services/recentReferrals");

describe("giveaway recent referral public classification", () => {
  it("applies review/fact/race/signup precedence and strips internal fields", () => {
    const candidates = [
      {
        id: "signup",
        referralFactId: null,
        displayName: "Signed Up",
        attributedAt: new Date("2026-08-25T10:00:00.000Z"),
      },
      {
        id: "racing",
        referralFactId: null,
        displayName: "In Race",
        attributedAt: new Date("2026-08-25T09:00:00.000Z"),
        raceJoinedAt: new Date("2026-08-25T11:00:00.000Z"),
      },
      {
        id: "flagged",
        referralFactId: "flagged",
        displayName: "Under Review",
        attributedAt: new Date("2026-08-25T08:00:00.000Z"),
        factStatus: "FLAGGED",
        qualifiedAt: new Date("2026-08-25T12:00:00.000Z"),
      },
      {
        id: "qualified",
        referralFactId: "qualified",
        displayName: "Qualified",
        attributedAt: new Date("2026-08-25T07:00:00.000Z"),
        factStatus: "REWARDED",
        qualifiedAt: new Date("2026-08-25T13:00:00.000Z"),
      },
      {
        id: "rejected",
        referralFactId: "rejected",
        displayName: "Not Counted",
        attributedAt: new Date("2026-08-25T06:00:00.000Z"),
        factStatus: "REWARDED",
        qualifiedAt: new Date("2026-08-25T14:00:00.000Z"),
      },
    ];
    const reviews = [
      {
        referralFactId: "rejected",
        decision: "REJECT",
        decidedAt: new Date("2026-08-25T15:00:00.000Z"),
        reasonCode: "PRIVATE_REASON",
      },
    ];

    assert.deepEqual(buildRecentReferrals(candidates, reviews), [
      {
        displayName: "Not Counted",
        occurredAt: "2026-08-25T15:00:00.000Z",
        status: "NOT_COUNTED",
      },
      {
        displayName: "Qualified",
        occurredAt: "2026-08-25T13:00:00.000Z",
        status: "QUALIFIED",
      },
      {
        displayName: "Under Review",
        occurredAt: "2026-08-25T12:00:00.000Z",
        status: "UNDER_REVIEW",
      },
      {
        displayName: "In Race",
        occurredAt: "2026-08-25T11:00:00.000Z",
        status: "IN_RACE",
      },
    ]);
  });

  it("treats approved flagged facts as qualified and uses stable newest-first order", () => {
    const at = new Date("2026-08-25T12:00:00.000Z");
    const candidates = [
      { id: "a", referralFactId: "a", displayName: "A", attributedAt: at, factStatus: "FLAGGED", qualifiedAt: at },
      { id: "b", referralFactId: "b", displayName: "B", attributedAt: at, factStatus: "QUALIFIED", qualifiedAt: at },
    ];
    const reviews = [{ referralFactId: "a", decision: "APPROVE", decidedAt: at }];

    assert.deepEqual(buildRecentReferrals(candidates, reviews), [
      { displayName: "B", occurredAt: at.toISOString(), status: "QUALIFIED" },
      { displayName: "A", occurredAt: at.toISOString(), status: "QUALIFIED" },
    ]);
  });
});
