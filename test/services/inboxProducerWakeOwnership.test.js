const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildRespondRaceJoinRequest,
} = require("../../src/modules/races/commands/respondRaceJoinRequest");

const ROOT = path.resolve(__dirname, "../..");

for (const relative of [
  "src/modules/races/commands/createRaceJoinRequest.js",
  "src/modules/races/commands/respondRaceJoinRequest.js",
]) {
  test(`${relative} owns a post-transaction Inbox wake`, () => {
    const source = fs.readFileSync(path.join(ROOT, relative), "utf8");
    assert.match(source, /publishInboxWake/);
    assert.match(source, /publishNotificationWakeup/);
    assert.match(source, /await publishInboxWake\(\)/);
    assert.match(source, /\$transaction|withRaceJoinLock/);
  });
}

function acceptedRequestFixture() {
  return {
    id: "request-1",
    raceId: "race-1",
    creatorUserId: "creator-1",
    requesterUserId: "requester-1",
    status: "PENDING",
    team: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    respondedAt: null,
    terminalActorUserId: null,
    failureCode: null,
  };
}

test("accepted join request publishes the committed Inbox wake before unrelated post-commit work", async () => {
  const request = acceptedRequestFixture();
  const order = [];
  let releasePostCommit;
  const held = new Promise((resolve) => { releasePostCommit = resolve; });
  const tx = {
    $executeRaw: async () => 1,
    friendship: { findMany: async () => [] },
    friendshipAutoLinkSuppression: { findUnique: async () => null },
    raceJoinRequest: {
      findUnique: async () => request,
      update: async () => ({ ...request, status: "ACCEPTED" }),
    },
    race: {
      findUnique: async () => ({ id: request.raceId, status: "PENDING", participants: [] }),
    },
  };
  const command = buildRespondRaceJoinRequest({
    prisma: { raceJoinRequest: { findUnique: async () => request } },
    withRaceJoinLock: async (_raceId, callback) => callback(tx),
    joinRaceCore: async () => ({
      runPostCommit: async () => { order.push("postcommit-start"); await held; },
    }),
    createInboxAlert: async () => {},
    publishInboxWake: async () => { order.push("wake"); },
  });

  const resultPromise = command({
    raceId: request.raceId,
    requestId: request.id,
    creatorUserId: request.creatorUserId,
    action: "ACCEPT",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["wake", "postcommit-start"]);
  releasePostCommit();
  await resultPromise;
});

test("failed accepted join transaction does not publish an Inbox wake", async () => {
  const request = acceptedRequestFixture();
  let wakes = 0;
  const command = buildRespondRaceJoinRequest({
    prisma: { raceJoinRequest: { findUnique: async () => request } },
    withRaceJoinLock: async () => { throw new Error("transaction rolled back"); },
    publishInboxWake: async () => { wakes += 1; },
  });

  await assert.rejects(command({
    raceId: request.raceId,
    requestId: request.id,
    creatorUserId: request.creatorUserId,
    action: "ACCEPT",
  }), /transaction rolled back/);
  assert.equal(wakes, 0);
});
