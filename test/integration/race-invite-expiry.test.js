const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

describe("race invite expiry", () => {
  let server;

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("persists a 72-hour expiry through the real invite endpoint", async () => {
    const creator = await createTestUser({ displayName: "expiry-creator" });
    const invitee = await createTestUser({ displayName: "expiry-invitee" });
    await prisma.friendship.create({
      data: {
        requesterId: creator.user.id,
        addresseeId: invitee.user.id,
        status: "ACCEPTED",
      },
    });

    const createStartedAt = Date.now();
    const createResponse = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      body: { name: "72 hour invite", maxDurationDays: 7 },
    });
    assert.equal(createResponse.status, 201);
    const raceId = (await createResponse.json()).race.id;

    const inviteResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/invite`,
      { token: creator.token, body: { inviteeIds: [invitee.user.id] } },
    );
    const inviteFinishedAt = Date.now();
    assert.equal(inviteResponse.status, 200);

    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: invitee.user.id } },
    });
    const earliestExpiry = createStartedAt + 72 * 60 * 60 * 1000;
    const latestExpiry = inviteFinishedAt + 72 * 60 * 60 * 1000;
    assert.ok(participant.inviteExpiresAt.getTime() >= earliestExpiry);
    assert.ok(participant.inviteExpiresAt.getTime() <= latestExpiry);
  });
});
