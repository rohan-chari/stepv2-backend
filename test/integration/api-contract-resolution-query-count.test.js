process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";

const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { beforeEach, describe, it } = require("node:test");

const { cleanDatabase, createTestUser, prisma } = require("./setup");
const {
  writeParticipantsBulk,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");

let observed = null;
prisma.$on("query", (event) => observed?.push(event));

async function seedAndWrite(size) {
  await cleanDatabase();
  const { user: creator } = await createTestUser({ displayName: `Bulk ${size}` });
  const users = Array.from({ length: size }, (_, index) => ({
    id: randomUUID(),
    appleId: `bulk-plan-${size}-${index}`,
  }));
  await prisma.user.createMany({ data: users });
  const race = await prisma.race.create({
    data: {
      creatorId: creator.id,
      name: `Bulk Plan ${size}`,
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: new Date("2026-08-13T11:00:00.000Z"),
      endsAt: new Date("2026-08-14T11:00:00.000Z"),
      maxParticipants: null,
    },
  });
  const participantRows = users.map((user) => ({
    id: randomUUID(),
    raceId: race.id,
    userId: user.id,
    status: "ACCEPTED",
  }));
  await prisma.raceParticipant.createMany({ data: participantRows });

  const events = [];
  observed = events;
  try {
    await prisma.$transaction((tx) =>
      writeParticipantsBulk(
        tx,
        participantRows.map((participant, index) => ({
          kind: "participantTotal",
          participantId: participant.id,
          totalSteps: 1000 + index,
          rawSteps: 900 + index,
        })),
        new Date("2026-08-13T12:00:00.000Z")
      )
    );
  } finally {
    observed = null;
  }
  return events.filter(
    (event) =>
      /race_participants/i.test(event.query || "") &&
      (/FOR UPDATE/i.test(event.query || "") || /UPDATE race_participants/i.test(event.query || ""))
  );
}

describe("resolution bulk persistence query scaling", () => {
  beforeEach(cleanDatabase);

  it("uses exactly one ordered lock plus one set update at 10/100/350 participants", async () => {
    const evidence = {};
    for (const size of [10, 100, 350]) {
      const events = await seedAndWrite(size);
      evidence[size] = events.length;
      assert.equal(events.length, 2, `${size}-participant persistence statements`);
    }
    assert.deepEqual(evidence, { 10: 2, 100: 2, 350: 2 });
  });
});
