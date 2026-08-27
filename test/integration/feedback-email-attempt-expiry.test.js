const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");

const {
  buildFeedbackEmailAttemptExpiry,
} = require("../../src/modules/feedback/jobs/feedbackEmailAttemptExpiry");
const { cleanDatabase, createTestUser, prisma } = require("./setup");

const NOW = new Date("2026-08-27T18:30:00.000Z");

describe("feedback email attempt expiry", () => {
  beforeEach(cleanDatabase);

  it("uses a durable claim and deletes expired attempts in bounded batches", async () => {
    const { user } = await createTestUser();
    for (let index = 0; index < 5; index += 1) {
      await prisma.feedbackEmailAttempt.create({
        data: {
          userId: user.id,
          utcDay: new Date("2026-08-19T00:00:00.000Z"),
          state: "ACCEPTED",
          messageId: `<expired-${index}@barastep.com>`,
          expiresAt: new Date(NOW.getTime() - 1_000 - index),
        },
      });
    }
    await prisma.feedbackEmailAttempt.create({
      data: {
        userId: user.id,
        utcDay: new Date("2026-08-27T00:00:00.000Z"),
        state: "RESERVED",
        messageId: "<retained@barastep.com>",
        expiresAt: new Date(NOW.getTime() + 60_000),
      },
    });
    const claims = [];
    const run = buildFeedbackEmailAttemptExpiry({
      prisma,
      now: () => NOW,
      batchSize: 2,
      JobRun: {
        async claimRun(jobName, runKey) {
          claims.push([jobName, runKey]);
          return true;
        },
      },
      logger: { log() {}, error() {} },
    });

    assert.deepEqual(await run(), { deleted: 5, batches: 3 });
    assert.deepEqual(claims, [["feedback_email_attempt_expiry", "2026-08-27T18"]]);
    assert.deepEqual(
      (await prisma.feedbackEmailAttempt.findMany()).map((row) => row.messageId),
      ["<retained@barastep.com>"]
    );
  });

  it("does nothing when another scheduler owns the durable claim", async () => {
    const run = buildFeedbackEmailAttemptExpiry({
      prisma,
      now: () => NOW,
      JobRun: { async claimRun() { return false; } },
      logger: { log() {}, error() {} },
    });
    assert.equal(await run(), null);
  });
});
