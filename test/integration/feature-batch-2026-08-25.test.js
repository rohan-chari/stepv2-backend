const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const { appSettings } = require("../../src/shared/config/appSettings");
const {
  buildDailyRewardReminder,
} = require("../../src/modules/notifications/dailyRewardReminder");
const {
  buildRaceAdminCommandWorker,
} = require("../../src/modules/races/jobs/raceAdminCommandRunner");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createLegacyFeedbackThread,
  createTestUser,
} = require("./setup");

let server;
let sequence = 0;
const execFileAsync = promisify(execFile);

async function makeUser(displayName) {
  const { user, token } = await createTestUser({
    appleId: `apple-feature-batch-2026-08-25-${++sequence}`,
    email: `feature-batch-2026-08-25-${sequence}@example.com`,
    displayName,
  });
  return { user, token };
}

async function makeFriends(requester, addressee) {
  const sent = await request(server.baseUrl, "POST", "/friends/request", {
    token: requester.token,
    body: { addresseeId: addressee.user.id },
  });
  const friendshipId = (await sent.json()).friendship.id;
  const accepted = await request(
    server.baseUrl,
    "PUT",
    `/friends/request/${friendshipId}`,
    { token: addressee.token, body: { accept: true } },
  );
  assert.equal(accepted.status, 200);
}

async function createActiveRace(owner, others, overrides = {}) {
  for (const other of others) await makeFriends(owner, other);
  const created = await request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    body: {
      name: overrides.name || "August 25 invariant race",
      targetSteps: 200_000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 5_000,
      ...overrides,
    },
  });
  assert.equal(created.status, 201);
  const raceId = (await created.json()).race.id;
  if (others.length > 0) {
    const invited = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/invite`,
      {
        token: owner.token,
        body: { inviteeIds: others.map((other) => other.user.id) },
      },
    );
    assert.equal(invited.status, 200);
    for (const other of others) {
      const accepted = await request(
        server.baseUrl,
        "PUT",
        `/races/${raceId}/respond`,
        { token: other.token, body: { accept: true } },
      );
      assert.equal(accepted.status, 200);
    }
  }
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  if (race.status !== "ACTIVE") {
    const started = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/start`,
      { token: owner.token },
    );
    assert.equal(started.status, 200);
  }
  return raceId;
}

async function setParticipantScore(raceId, userId, { totalSteps, bonusSteps = 0 }) {
  return prisma.raceParticipant.update({
    where: { raceId_userId: { raceId, userId } },
    data: { totalSteps, rawSteps: Math.max(0, totalSteps - bonusSteps), bonusSteps },
  });
}

async function grantHeldPowerup(raceId, userId, type, earnedAtSteps) {
  const participant = await prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: participant.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

function usePowerup(user, raceId, powerupId, body) {
  return request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${powerupId}/use`,
    { token: user.token, body },
  );
}

function findParticipant(payload, userId) {
  return payload.participants.find((participant) => participant.userId === userId);
}

describe("feature batch 2026-08-25 — backend public contracts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    sequence = 0;
  });

  afterEach(async () => {
    await appSettings.setFlag("apiInboxV1Enabled", false);
  });

  it("floors a Pinecone Toss at zero and reports the actually applied penalty on every public race projection", async () => {
    const attacker = await makeUser("Pinecone Attacker");
    const target = await makeUser("Low Step Target");
    const raceId = await createActiveRace(attacker, [target]);

    await setParticipantScore(raceId, attacker.user.id, { totalSteps: 0 });
    await setParticipantScore(raceId, target.user.id, { totalSteps: 250 });
    const pinecone = await grantHeldPowerup(
      raceId,
      attacker.user.id,
      "PINECONE_TOSS",
      5_001,
    );

    const used = await usePowerup(attacker, raceId, pinecone.id, {
      targetDirection: "FRONT",
    });
    assert.equal(used.status, 200);
    const useBody = await used.json();
    assert.equal(useBody.result.penalty, 250);

    const persisted = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: target.user.id } },
    });
    assert.equal(persisted.totalSteps, 0);
    assert.equal(persisted.bonusSteps, -250);

    const detailResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}`,
      { token: attacker.token },
    );
    assert.equal(detailResponse.status, 200);
    const detailTarget = findParticipant(await detailResponse.json(), target.user.id);
    assert.equal(detailTarget.totalSteps, 0);

    const progressResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: attacker.token },
    );
    assert.equal(progressResponse.status, 200);
    const progressTarget = findParticipant(
      (await progressResponse.json()).progress,
      target.user.id,
    );
    assert.equal(progressTarget.totalSteps, 0);

    const listResponse = await request(server.baseUrl, "GET", "/races", {
      token: target.token,
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    const listRace = [
      ...(listBody.active || []),
      ...(listBody.pending || []),
      ...(listBody.completed || []),
    ].find((race) => race.id === raceId);
    assert.ok(listRace);
    assert.ok((listRace.mySteps ?? 0) >= 0);
  });

  it("serializes concurrent penalties so the participant aggregate cannot cross below zero", async () => {
    const attacker = await makeUser("Concurrent Attacker");
    const target = await makeUser("Concurrent Target");
    const raceId = await createActiveRace(attacker, [target]);
    await setParticipantScore(raceId, attacker.user.id, { totalSteps: 0 });
    await setParticipantScore(raceId, target.user.id, { totalSteps: 900 });

    const first = await grantHeldPowerup(raceId, attacker.user.id, "PINECONE_TOSS", 6_001);
    const second = await grantHeldPowerup(raceId, attacker.user.id, "PINECONE_TOSS", 6_002);
    const responses = await Promise.all([
      usePowerup(attacker, raceId, first.id, { targetDirection: "FRONT" }),
      usePowerup(attacker, raceId, second.id, { targetDirection: "FRONT" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(
      bodies.reduce((sum, body) => sum + body.result.penalty, 0),
      900,
    );

    const persisted = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: target.user.id } },
    });
    assert.equal(persisted.totalSteps, 0);
    assert.equal(persisted.bonusSteps, -900);
  });

  it("concurrent Shortcuts conserve steps and publish the committed transfer metadata", async () => {
    const attacker = await makeUser("Concurrent Shortcut Attacker");
    const target = await makeUser("Concurrent Shortcut Target");
    const raceId = await createActiveRace(attacker, [target]);
    await setParticipantScore(raceId, attacker.user.id, { totalSteps: 0 });
    await setParticipantScore(raceId, target.user.id, { totalSteps: 1_200 });

    const first = await grantHeldPowerup(raceId, attacker.user.id, "SHORTCUT", 6_101);
    const second = await grantHeldPowerup(raceId, attacker.user.id, "SHORTCUT", 6_102);
    const responses = await Promise.all([
      usePowerup(attacker, raceId, first.id, { targetUserId: target.user.id }),
      usePowerup(attacker, raceId, second.id, { targetUserId: target.user.id }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.equal(
      bodies.reduce((sum, body) => sum + body.result.stolen, 0),
      1_200,
    );

    const rows = await prisma.raceParticipant.findMany({
      where: { raceId, userId: { in: [attacker.user.id, target.user.id] } },
    });
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    assert.equal(byUser.get(attacker.user.id).totalSteps, 1_200);
    assert.equal(byUser.get(target.user.id).totalSteps, 0);
    assert.equal(
      byUser.get(attacker.user.id).totalSteps + byUser.get(target.user.id).totalSteps,
      1_200,
    );

    const events = await prisma.racePowerupEvent.findMany({
      where: { raceId, powerupType: "SHORTCUT" },
      orderBy: { createdAt: "asc" },
    });
    assert.equal(
      events.reduce((sum, event) => sum + Number(event.metadata?.stolen || 0), 0),
      1_200,
    );
  });

  it("returns the normalized funded payout contract from detail and progress", async () => {
    const owner = await makeUser("Payout Owner");
    const runner = await makeUser("Payout Runner");
    const raceId = await createActiveRace(owner, [runner], {
      name: "Payout Projection Race",
    });

    const detailResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}`,
      { token: owner.token },
    );
    assert.equal(detailResponse.status, 200);
    const detail = await detailResponse.json();
    assert.equal(detail.prizePool.funded, true);
    assert.equal(detail.prizePool.projected, true);
    assert.ok(Number.isInteger(detail.prizePool.coins));
    assert.equal(detail.projectedPotCoins, detail.prizePool.coins);
    assert.deepEqual(Object.keys(detail.payouts), ["first", "second", "third"]);
    assert.ok(Array.isArray(detail.payoutTiers));

    const progressResponse = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: owner.token },
    );
    assert.equal(progressResponse.status, 200);
    const progress = (await progressResponse.json()).progress;
    assert.deepEqual(progress.prizePool, detail.prizePool);
    assert.equal(progress.projectedPotCoins, detail.projectedPotCoins);
    assert.deepEqual(progress.payouts, detail.payouts);
    assert.deepEqual(progress.payoutTiers, detail.payoutTiers);
  });

  it("keeps an explicit zero-payout contract on a forming funded race", async () => {
    const owner = await makeUser("Zero Payout Owner");
    const race = await prisma.race.create({
      data: {
        creatorId: owner.user.id,
        name: "Zero-player forming race",
        targetSteps: 10_000,
        maxDurationDays: 1,
        status: "PENDING",
        isPublic: true,
        fundedPrize: true,
        prizeCoinUnit: 20,
        payoutRoundingVersion: 1,
        maxParticipants: 10,
      },
    });
    // Historical partially-created rows can have a creator invite record but
    // zero accepted racers. The payout response must still stay defined.
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: owner.user.id,
        status: "INVITED",
      },
    });
    const response = await request(server.baseUrl, "GET", `/races/${race.id}`, {
      token: owner.token,
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.prizePool, {
      coins: 0,
      projected: true,
      atMax: false,
      playerCount: 0,
      durationDays: 1,
      durationPoints: 1,
      coinUnit: 20,
      maxCoins: 16_000,
      funded: true,
    });
    assert.equal(body.projectedPotCoins, 0);
    assert.deepEqual(body.payouts, { first: 0, second: 0, third: 0 });
    assert.deepEqual(body.payoutTiers, []);
  });

  it("prioritizes unread staff replies with stable timestamps and marks ordinary alerts separately", async () => {
    const user = await makeUser("Feedback Recipient");
    const admin = await makeUser("Feedback Admin");
    const adminEmail =
      process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { email: adminEmail },
    });
    await appSettings.setFlag("apiInboxV1Enabled", true);

    const thread = await createLegacyFeedbackThread({
      userId: user.user.id,
      text: "Please reply clearly.",
    });

    const replied = await request(
      server.baseUrl,
      "POST",
      `/admin/feedback/threads/${thread.id}/messages`,
      {
        token: admin.token,
        headers: { "X-Client-Features": "inbox_v1" },
        body: {
          text: "We saw your note.",
          idempotencyKey: "4d67eb3a-caca-4a5f-8017-d3da86a8f866",
        },
      },
    );
    assert.equal(replied.status, 201);

    const alert = await prisma.inboxAlert.create({
      data: {
        userId: user.user.id,
        type: "SYSTEM",
        title: "Ordinary alert",
        body: "This should not clear the staff reply.",
        sourceKey: `ordinary-alert:${thread.id}`,
        destination: { route: "home" },
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    const listed = await request(
      server.baseUrl,
      "GET",
      "/feedback/threads?limit=20",
      {
        token: user.token,
        headers: { "X-Client-Features": "inbox_v1" },
      },
    );
    assert.equal(listed.status, 200);
    const listedThread = (await listed.json()).threads[0];
    assert.equal(listedThread.id, thread.id);
    assert.ok(Date.parse(listedThread.createdAt));
    assert.ok(Date.parse(listedThread.lastMessageAt));
    assert.ok(Date.parse(listedThread.lastStaffReplyAt));
    assert.equal(listedThread.hasUnreadStaffReply, true);
    assert.equal(listedThread.priority, 1);
    assert.equal(listedThread.sortAt, listedThread.lastStaffReplyAt);

    const readAlerts = await request(
      server.baseUrl,
      "POST",
      "/inbox/read-alerts",
      {
        token: user.token,
        headers: { "X-Client-Features": "inbox_v1" },
        body: {},
      },
    );
    assert.equal(readAlerts.status, 204);
    assert.equal(await readAlerts.text(), "");
    assert.ok((await prisma.inboxAlert.findUnique({ where: { id: alert.id } })).readAt);
    assert.equal(
      (await prisma.feedbackThread.findUnique({ where: { id: thread.id } })).userReadAt,
      null,
    );

    const opened = await request(
      server.baseUrl,
      "GET",
      `/feedback/threads/${thread.id}`,
      {
        token: user.token,
        headers: { "X-Client-Features": "inbox_v1" },
      },
    );
    assert.equal(opened.status, 200);
    const relisted = await request(
      server.baseUrl,
      "GET",
      "/feedback/threads?limit=20",
      {
        token: user.token,
        headers: { "X-Client-Features": "inbox_v1" },
      },
    );
    const readThread = (await relisted.json()).threads[0];
    assert.equal(readThread.hasUnreadStaffReply, false);
    assert.equal(readThread.priority, 0);
  });

  it("mediates a capable private share through an attributable creator approval request", async () => {
    const creator = await makeUser("Private Race Creator");
    const sharer = await makeUser("Nathan");
    const requester = await makeUser("Rohan");
    const unresolvedInvitee = await makeUser("Still Invited");
    await appSettings.setFlag("apiInboxV1Enabled", true);
    await makeFriends(creator, sharer);
    await makeFriends(creator, unresolvedInvitee);

    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      body: {
        name: "wyd STEP bro",
        targetSteps: 100_000,
        maxDurationDays: 7,
        maxParticipants: 4,
        isPublic: false,
      },
    });
    assert.equal(created.status, 201);
    const raceId = (await created.json()).race.id;
    const invited = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/invite`,
      {
        token: creator.token,
        body: { inviteeIds: [sharer.user.id, unresolvedInvitee.user.id] },
      },
    );
    assert.equal(invited.status, 200);
    const sharerAccepted = await request(
      server.baseUrl,
      "PUT",
      `/races/${raceId}/respond`,
      { token: sharer.token, body: { accept: true } },
    );
    assert.equal(sharerAccepted.status, 200);

    const capableHeaders = {
      "X-Client-Features": "privateJoinApproval,inbox_v1",
    };
    const minted = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: sharer.token, headers: capableHeaders },
    );
    assert.equal(minted.status, 201);
    const capableLink = await minted.json();
    assert.equal(capableLink.approvalRequired, true);
    assert.ok(Date.parse(capableLink.expiresAt));
    assert.match(capableLink.url, new RegExp(`/r/${capableLink.shareToken}`));

    const preview = await request(
      server.baseUrl,
      "GET",
      `/races/share/${capableLink.shareToken}`,
    );
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.race.id, raceId);
    assert.equal(previewBody.approvalRequired, true);
    assert.equal(previewBody.expiresAt, capableLink.expiresAt);

    const requested = await request(
      server.baseUrl,
      "POST",
      `/races/share/${capableLink.shareToken}/join-requests`,
      { token: requester.token, body: { team: null } },
    );
    assert.equal(requested.status, 202);
    const requestBody = await requested.json();
    assert.equal(requestBody.joinRequest.raceId, raceId);
    assert.equal(requestBody.joinRequest.sharedByUserId, sharer.user.id);
    assert.equal(requestBody.joinRequest.requesterUserId, requester.user.id);
    assert.equal(requestBody.joinRequest.creatorUserId, creator.user.id);
    assert.equal(requestBody.joinRequest.status, "PENDING");
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId, userId: requester.user.id },
      }),
      0,
    );

    const creatorInbox = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: creator.token,
      headers: { "X-Client-Features": "inbox_v1" },
    });
    assert.equal(creatorInbox.status, 200);
    const approvalAlert = (await creatorInbox.json()).alerts.find(
      (alert) => alert.type === "PRIVATE_RACE_JOIN_APPROVAL",
    );
    assert.equal(approvalAlert.destination, "RACE_JOIN_REQUEST");
    assert.equal(approvalAlert.raceId, raceId);
    assert.equal(approvalAlert.requestId, requestBody.joinRequest.id);
    assert.deepEqual(approvalAlert.destinationDetails, {
      route: "raceJoinRequest",
      raceId,
      requestId: requestBody.joinRequest.id,
    });

    const replay = await request(
      server.baseUrl,
      "POST",
      `/races/share/${capableLink.shareToken}/join-requests`,
      { token: requester.token, body: { team: null } },
    );
    assert.equal(replay.status, 202);
    assert.equal((await replay.json()).joinRequest.id, requestBody.joinRequest.id);

    const recovery = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/join-requests?status=PENDING&limit=20`,
      { token: creator.token },
    );
    assert.equal(recovery.status, 200);
    assert.deepEqual(
      (await recovery.json()).joinRequests.map((entry) => entry.id),
      [requestBody.joinRequest.id],
    );

    const wrongCreator = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join-requests/${requestBody.joinRequest.id}/respond`,
      { token: sharer.token, body: { action: "ACCEPT" } },
    );
    assert.equal(wrongCreator.status, 403);
    assert.equal((await wrongCreator.json()).code, "NOT_RACE_CREATOR");

    const accepted = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join-requests/${requestBody.joinRequest.id}/respond`,
      { token: creator.token, body: { action: "ACCEPT" } },
    );
    assert.equal(accepted.status, 200);
    const acceptedBody = await accepted.json();
    assert.equal(acceptedBody.joinRequest.status, "ACCEPTED");
    assert.equal(acceptedBody.joinRequest.failureCode, null);
    assert.ok(Date.parse(acceptedBody.joinRequest.respondedAt));
    const membership = await prisma.raceParticipant.findUnique({
      where: {
        raceId_userId: { raceId, userId: requester.user.id },
      },
    });
    assert.equal(membership.status, "ACCEPTED");

    const requesterInbox = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: requester.token,
      headers: { "X-Client-Features": "inbox_v1" },
    });
    assert.equal(requesterInbox.status, 200);
    const resultAlert = (await requesterInbox.json()).alerts.find(
      (alert) => alert.type === "PRIVATE_RACE_JOIN_RESULT",
    );
    assert.equal(resultAlert.destination, "RACE");
    assert.equal(resultAlert.raceId, raceId);
    assert.equal(resultAlert.requestId, requestBody.joinRequest.id);
    assert.equal(resultAlert.status, "ACCEPTED");
    assert.deepEqual(resultAlert.destinationDetails, {
      route: "raceDetail",
      raceId,
      requestId: requestBody.joinRequest.id,
      status: "ACCEPTED",
    });

    const requesterStatus = await request(
      server.baseUrl,
      "GET",
      `/race-join-requests/${requestBody.joinRequest.id}`,
      { token: requester.token },
    );
    assert.equal(requesterStatus.status, 200);
    assert.equal((await requesterStatus.json()).joinRequest.status, "ACCEPTED");
    const terminalReplay = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join-requests/${requestBody.joinRequest.id}/respond`,
      { token: creator.token, body: { action: "ACCEPT" } },
    );
    assert.equal(terminalReplay.status, 200);
    assert.equal((await terminalReplay.json()).joinRequest.status, "ACCEPTED");
  });

  it("rejects a blocked creator relationship both when requesting and when accepting", async () => {
    const creator = await makeUser("Blocked Race Creator");
    const sharer = await makeUser("Blocked Race Sharer");
    const unresolved = await makeUser("Blocked Race Unresolved Invite");
    const blockedAtRequest = await makeUser("Blocked Before Request");
    const blockedAtAccept = await makeUser("Blocked Before Accept");
    await makeFriends(creator, sharer);
    await makeFriends(creator, unresolved);
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      body: {
        name: "Relationship guarded race",
        targetSteps: 100_000,
        maxDurationDays: 7,
        maxParticipants: 5,
        isPublic: false,
      },
    });
    const raceId = (await created.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      token: creator.token,
      body: { inviteeIds: [sharer.user.id, unresolved.user.id] },
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: sharer.token,
      body: { accept: true },
    });
    const minted = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: sharer.token,
      headers: { "X-Client-Features": "privateJoinApproval,inbox_v1" },
    });
    const shareToken = (await minted.json()).shareToken;

    const sentBefore = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: blockedAtRequest.user.id },
    });
    const beforeFriendshipId = (await sentBefore.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${beforeFriendshipId}`, {
      token: blockedAtRequest.token,
      body: { accept: false },
    });
    const blockedRequest = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join-requests`,
      { token: blockedAtRequest.token, body: {} },
    );
    assert.equal(blockedRequest.status, 409);
    assert.deepEqual(await blockedRequest.json(), {
      error: "This relationship does not allow race invitations",
      code: "BLOCKED_RELATIONSHIP",
    });

    const pending = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join-requests`,
      { token: blockedAtAccept.token, body: {} },
    );
    assert.equal(pending.status, 202);
    const requestId = (await pending.json()).joinRequest.id;
    const sentAfter = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: blockedAtAccept.user.id },
    });
    const afterFriendshipId = (await sentAfter.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${afterFriendshipId}`, {
      token: blockedAtAccept.token,
      body: { accept: false },
    });
    const blockedAccept = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join-requests/${requestId}/respond`,
      { token: creator.token, body: { action: "ACCEPT" } },
    );
    assert.equal(blockedAccept.status, 409);
    assert.deepEqual(await blockedAccept.json(), {
      error: "This relationship does not allow race invitations",
      code: "BLOCKED_RELATIONSHIP",
    });
    const terminal = await prisma.raceJoinRequest.findUniqueOrThrow({
      where: { id: requestId },
    });
    assert.equal(terminal.status, "EXPIRED");
    assert.equal(terminal.failureCode, "BLOCKED_RELATIONSHIP");
  });

  it("preserves legacy private direct-join while capable declines cool down and expired links return 410", async () => {
    const creator = await makeUser("Compatibility Creator");
    const sharer = await makeUser("Compatibility Sharer");
    const unresolved = await makeUser("Compatibility Invite");
    const declinee = await makeUser("Declined Requester");
    const legacyJoiner = await makeUser("Legacy Joiner");
    await makeFriends(creator, sharer);
    await makeFriends(creator, unresolved);
    const created = await request(server.baseUrl, "POST", "/races", {
      token: creator.token,
      body: {
        name: "Private compatibility race",
        targetSteps: 100_000,
        maxDurationDays: 7,
        maxParticipants: 6,
        isPublic: false,
      },
    });
    const raceId = (await created.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      token: creator.token,
      body: { inviteeIds: [sharer.user.id, unresolved.user.id] },
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: sharer.token,
      body: { accept: true },
    });
    const capableHeaders = { "X-Client-Features": "privateJoinApproval,inbox_v1" };
    const capable = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: sharer.token,
      headers: capableHeaders,
    });
    const capableToken = (await capable.json()).shareToken;
    const pending = await request(
      server.baseUrl,
      "POST",
      `/races/share/${capableToken}/join-requests`,
      { token: declinee.token, body: {} },
    );
    const pendingId = (await pending.json()).joinRequest.id;
    const declined = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/join-requests/${pendingId}/respond`,
      { token: creator.token, body: { action: "DECLINE" } },
    );
    assert.equal(declined.status, 200);
    assert.equal((await declined.json()).joinRequest.status, "DECLINED");
    const cooldown = await request(
      server.baseUrl,
      "POST",
      `/races/share/${capableToken}/join-requests`,
      { token: declinee.token, body: {} },
    );
    assert.equal(cooldown.status, 409);
    assert.equal((await cooldown.json()).code, "JOIN_REQUEST_COOLDOWN");

    const legacy = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: sharer.token,
    });
    const legacyBody = await legacy.json();
    assert.equal("approvalRequired" in legacyBody, false);
    assert.equal("expiresAt" in legacyBody, false);
    const legacyPreview = await request(
      server.baseUrl,
      "GET",
      `/races/share/${legacyBody.shareToken}`,
    );
    const legacyPreviewBody = await legacyPreview.json();
    assert.equal("approvalRequired" in legacyPreviewBody, false);
    assert.equal("expiresAt" in legacyPreviewBody, false);
    const directJoin = await request(
      server.baseUrl,
      "POST",
      `/races/share/${legacyBody.shareToken}/join`,
      { token: legacyJoiner.token, body: {} },
    );
    assert.equal(directJoin.status, 201);
    assert.ok((await directJoin.json()).participant.id);

    const expiring = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: sharer.token,
      headers: capableHeaders,
    });
    const expiringToken = (await expiring.json()).shareToken;
    const newest = await prisma.raceShareLink.findFirstOrThrow({
      where: { raceId },
      orderBy: { createdAt: "desc" },
    });
    await prisma.raceShareLink.update({
      where: { id: newest.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const expired = await request(
      server.baseUrl,
      "GET",
      `/races/share/${expiringToken}`,
    );
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, "SHARE_LINK_EXPIRED");
  });

  it("UNCLAIMED_REWARD_REMINDER_V1 gives an active mystery box priority and deduplicates the local day", async () => {
    const owner = await makeUser("Reminder Owner");
    const opponent = await makeUser("Reminder Opponent");
    const raceId = await createActiveRace(owner, [opponent], {
      name: "Reminder race",
      maxDurationDays: 2,
    });
    const participant = await prisma.raceParticipant.findUnique({
      where: { raceId_userId: { raceId, userId: owner.user.id } },
    });
    await prisma.user.update({
      where: { id: owner.user.id },
      data: { timezone: "America/New_York", lastDailyClaimDate: null },
    });
    await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: owner.user.id,
        status: "MYSTERY_BOX",
        type: null,
      },
    });
    const current = new Date("2026-08-26T21:15:00.000Z");
    const run = buildDailyRewardReminder({
      prisma,
      now: () => current,
      User: {
        async distinctTimezones() { return ["America/New_York"]; },
      },
      JobRun: {
        async lastRanFor() { return null; },
        async markRan() {},
      },
      logger: { log() {}, error(error) { throw error; } },
      isDisabled: () => false,
    });
    await run();
    await run();
    const events = await prisma.domainEventOutbox.findMany({
      where: {
        eventType: "UNCLAIMED_REWARD_REMINDER_V1",
        aggregateId: owner.user.id,
      },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventKey, `UNCLAIMED_REWARD:${owner.user.id}:2026-08-26`);
    assert.equal(events[0].payload.rewardType, "MYSTERY_BOX");
    assert.equal(events[0].payload.raceId, raceId);
  });

  it("adds timeline-v1 only on the opted-in bounded merged messages view", async () => {
    const owner = await makeUser("Timeline Owner");
    const opponent = await makeUser("Timeline Opponent");
    const raceId = await createActiveRace(owner, [opponent], {
      name: "Bounded timeline race",
    });
    await prisma.raceMessage.createMany({
      data: Array.from({ length: 55 }, (_, index) => ({
        raceId,
        senderId: owner.user.id,
        kind: "USER",
        body: `timeline message ${index}`,
        createdAt: new Date(Date.now() - index * 1000),
      })),
    });

    const legacy = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?limit=1`,
      { token: owner.token },
    );
    assert.equal(legacy.status, 200);
    assert.equal("timelineVersion" in await legacy.json(), false);

    const defaultPage = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?view=timeline-v1`,
      { token: owner.token },
    );
    const defaultBody = await defaultPage.json();
    assert.equal(defaultPage.status, 200);
    assert.equal(defaultBody.timelineVersion, 1);
    assert.equal(defaultBody.messages.length, 30);
    assert.ok(defaultBody.nextCursor);

    const clamped = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?view=timeline-v1&limit=500`,
      { token: opponent.token },
    );
    const clampedBody = await clamped.json();
    assert.equal(clamped.status, 200);
    assert.equal(clampedBody.timelineVersion, 1);
    assert.equal(clampedBody.messages.length, 50);
  });

  it("serves a branded browser 404 without converting API or asset misses to HTML", async () => {
    const browser = await fetch(`${server.baseUrl}/this-page-does-not-exist`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(browser.status, 404);
    assert.match(browser.headers.get("content-type"), /text\/html/);
    const html = await browser.text();
    assert.match(html, /This page couldn’t be found/);
    assert.match(html, /share-card\.png/);
    assert.match(html, /href="\/"/);

    const head = await fetch(`${server.baseUrl}/another-missing-page`, {
      method: "HEAD",
      headers: { Accept: "text/html" },
    });
    assert.equal(head.status, 404);
    assert.match(head.headers.get("content-type"), /text\/html/);

    const apiViewer = await makeUser("API 404 Viewer");
    for (const [path, headers] of [
      ["/races/no-such-race", { Authorization: `Bearer ${apiViewer.token}`, Accept: "text/html" }],
      ["/auth/no-such-route", { Accept: "text/html" }],
      ["/health/no-such-route", { Accept: "text/html" }],
    ]) {
      const api = await fetch(`${server.baseUrl}${path}`, {
        headers,
      });
      assert.equal(api.status, 404);
      assert.match(api.headers.get("content-type"), /application\/json/);
      assert.equal(typeof (await api.json()).error, "string");
    }

    const asset = await fetch(`${server.baseUrl}/assets/no-such-image.png`, {
      headers: { Accept: "text/html" },
    });
    assert.equal(asset.status, 404);
    assert.doesNotMatch(asset.headers.get("content-type") || "", /text\/html/);
  });

  it("activates only an ACTIVE tournament matchup once with a coherent non-retro baseline", async () => {
    const owner = await makeUser("Admin Command Owner");
    const opponent = await makeUser("Admin Command Opponent");
    const raceId = await createActiveRace(owner, [opponent], {
      name: "Admin command race",
      powerupsEnabled: false,
    });
    const tournament = await prisma.tournament.create({
      data: {
        name: "Activation parent",
        status: "ACTIVE",
        bracketSize: 4,
        matchupDurationDays: 1,
        totalRounds: 2,
        currentRound: 1,
      },
    });
    await prisma.race.update({
      where: { id: raceId },
      data: { tournamentId: tournament.id, tournamentRound: 1, tournamentMatchIndex: 0 },
    });
    const participants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[0].id },
      data: { rawSteps: 4_000, totalSteps: 4_000 },
    });
    await prisma.raceParticipant.update({
      where: { id: participants[1].id },
      data: { rawSteps: 6_000, totalSteps: 6_000 },
    });
    const activatedAt = "2026-08-25T16:00:00.000Z";
    await prisma.raceAdminCommand.create({
      data: {
        raceId,
        commandType: "TOURNAMENT_POWERUPS_ACTIVATE",
        dedupeKey: `tournament-powerups:${raceId}`,
        payload: {
          raceId,
          tournamentId: tournament.id,
          activatedAt,
          interval: 2_000,
          baselineByParticipant: {
            [participants[0].id]: 4_000,
            [participants[1].id]: 6_000,
          },
        },
      },
    });
    const invalidated = { races: [], tournaments: [], users: [] };
    const run = buildRaceAdminCommandWorker({
      prisma,
      logger: { log() {}, error() {} },
      async invalidateRaceProgress(id) { invalidated.races.push(id); },
      async invalidateTournament(id) { invalidated.tournaments.push(id); },
      async invalidateRaceListUser(id) { invalidated.users.push(id); },
    });
    assert.equal(await run(), true);
    assert.equal(await run(), false);

    const race = await prisma.race.findUnique({ where: { id: raceId } });
    assert.equal(race.powerupsEnabled, true);
    assert.equal(race.powerupStepInterval, 2000);
    assert.equal(race.tournamentPowerupsActivatedAt.toISOString(), activatedAt);
    assert.deepEqual(invalidated.races, [raceId]);
    assert.deepEqual(invalidated.tournaments, [tournament.id]);
    assert.deepEqual(invalidated.users.sort(), participants.map((row) => row.userId).sort());
    const activatedParticipants = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    assert.deepEqual(
      activatedParticipants.map((participant) => [participant.baselineSteps, participant.nextBoxAtSteps]),
      [[4_000, 6_000], [6_000, 8_000]],
    );

    await prisma.raceParticipant.updateMany({
      where: { raceId },
      data: { rawSteps: 12_000, totalSteps: 12_000 },
    });
    await prisma.raceAdminCommand.create({
      data: {
        raceId,
        commandType: "TOURNAMENT_POWERUPS_ACTIVATE",
        dedupeKey: `tournament-powerups-replay:${raceId}`,
        payload: {
          raceId,
          tournamentId: tournament.id,
          activatedAt,
          interval: 2_000,
          baselineByParticipant: Object.fromEntries(
            participants.map((participant) => [participant.id, 12_000]),
          ),
        },
      },
    });
    assert.equal(await run(), true);
    const replayed = await prisma.raceParticipant.findMany({
      where: { raceId },
      orderBy: { userId: "asc" },
    });
    assert.deepEqual(
      replayed.map((participant) => [participant.baselineSteps, participant.nextBoxAtSteps]),
      [[4_000, 6_000], [6_000, 8_000]],
    );
    assert.deepEqual(invalidated.races, [raceId], "replay publishes no invalidation");

    const terminalOpponent = await makeUser("Terminal Activation Opponent");
    const terminalRaceId = await createActiveRace(owner, [terminalOpponent], {
      name: "Terminal activation race",
      powerupsEnabled: false,
    });
    await prisma.race.update({
      where: { id: terminalRaceId },
      data: {
        tournamentId: tournament.id,
        tournamentRound: 1,
        tournamentMatchIndex: 1,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await prisma.raceAdminCommand.create({
      data: {
        raceId: terminalRaceId,
        commandType: "TOURNAMENT_POWERUPS_ACTIVATE",
        dedupeKey: `tournament-powerups:${terminalRaceId}`,
        payload: { raceId: terminalRaceId, tournamentId: tournament.id, activatedAt, interval: 2_000 },
      },
    });
    assert.equal(await run(), true);
    assert.equal(
      (await prisma.race.findUnique({ where: { id: terminalRaceId } })).powerupsEnabled,
      false,
    );
  });

  it("keeps capacity-skipped historical cohort users pending and enrolls them on retry", async () => {
    const incumbent = await makeUser("Historical Capacity Incumbent");
    const skipped = await makeUser("Historical Capacity Retry");
    const seed = await prisma.raceSeed.upsert({
      where: { id: "historical-capacity-seed" },
      update: {
        active: true,
        maxParticipants: 1,
      },
      create: {
        id: "historical-capacity-seed",
        kind: "HISTORICAL_CAPACITY_DAILY",
        name: "Historical capacity daily",
        targetSteps: 10_000,
        durationHours: 24,
        cadence: "DAILY",
        maxParticipants: 1,
      },
    });
    const race = await prisma.race.create({
      data: {
        seedId: seed.id,
        name: seed.name,
        targetSteps: 10_000,
        maxDurationDays: 1,
        maxParticipants: 1,
        status: "ACTIVE",
        timezone: "America/New_York",
        startedAt: new Date("2026-08-25T04:00:00.000Z"),
        endsAt: new Date("2026-08-26T04:00:00.000Z"),
      },
    });
    const bucket = await prisma.seededRaceBucket.create({
      data: {
        seedId: seed.id,
        raceId: race.id,
        windowStart: new Date("2026-08-25T04:00:00.000Z"),
        windowEnd: new Date("2026-08-26T04:00:00.000Z"),
        status: "ACTIVE",
      },
    });
    await prisma.race.update({
      where: { id: race.id },
      data: { seededBucketId: bucket.id },
    });
    await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: incumbent.user.id, status: "ACCEPTED" },
    });
    const command = await prisma.raceAdminCommand.create({
      data: {
        raceId: race.id,
        commandType: "HISTORICAL_COHORT_ENROLLMENT",
        dedupeKey: `cohort-repair:${race.id}:2026-08-25`,
        payload: {
          raceId: race.id,
          userIds: [skipped.user.id],
          sourceDate: "2026-08-25",
          seedId: seed.id,
          cadence: "DAILY",
          seededBucketId: bucket.id,
          windowStart: "2026-08-25T04:00:00.000Z",
          windowEnd: "2026-08-26T04:00:00.000Z",
        },
      },
    });
    const run = buildRaceAdminCommandWorker({
      prisma,
      logger: { log() {}, error() {} },
    });
    assert.equal(await run(), true);
    const pending = await prisma.raceAdminCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    assert.equal(pending.status, "PENDING");
    assert.deepEqual(pending.payload.userIds, [skipped.user.id]);
    assert.deepEqual(pending.payload.skippedUserIds, [skipped.user.id]);
    assert.match(pending.lastError, /^CAPACITY_SKIPPED:/);
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId: race.id, userId: skipped.user.id },
      }),
      0,
    );

    await prisma.race.update({ where: { id: race.id }, data: { maxParticipants: 2 } });
    await prisma.raceAdminCommand.update({
      where: { id: command.id },
      data: { availableAt: new Date(Date.now() - 1_000) },
    });
    assert.equal(await run(), true);
    assert.equal(
      (await prisma.raceAdminCommand.findUniqueOrThrow({ where: { id: command.id } })).status,
      "COMPLETED",
    );
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId: race.id, userId: skipped.user.id, status: "ACCEPTED" },
      }),
      1,
    );
  });

  it("cohort CLI classifies the UTC signup date and idempotently enqueues only missing historical memberships", async () => {
    const signup = await makeUser("August 25 Cohort User");
    await prisma.user.update({
      where: { id: signup.user.id },
      data: { createdAt: new Date("2026-08-25T12:00:00.000Z") },
    });
    for (const [cadence, kind] of [["DAILY", "DAILY_10K"], ["WEEKLY", "WEEKLY_50K"]]) {
      const windowStart = new Date(cadence === "DAILY"
        ? "2026-08-25T04:00:00.000Z"
        : "2026-08-24T04:00:00.000Z");
      const windowEnd = new Date(cadence === "DAILY"
        ? "2026-08-26T04:00:00.000Z"
        : "2026-08-31T04:00:00.000Z");
      const seed = await prisma.raceSeed.upsert({
        where: { kind },
        update: { cadence, active: true },
        create: {
          id: `feature-batch-${cadence.toLowerCase()}`,
          kind,
          name: `${cadence} cohort seed`,
          targetSteps: 10_000,
          durationHours: cadence === "DAILY" ? 24 : 168,
          cadence,
          maxParticipants: 100,
          active: true,
        },
      });
      const race = await prisma.race.create({
        data: {
          seedId: seed.id,
          name: `${cadence} historical cohort`,
          targetSteps: 10_000,
          maxDurationDays: cadence === "DAILY" ? 1 : 7,
          status: "ACTIVE",
          startedAt: windowStart,
          endsAt: windowEnd,
          timezone: "America/New_York",
          fundedPrize: true,
          prizeCoinUnit: 10,
        },
      });
      const bucket = await prisma.seededRaceBucket.create({
        data: {
          seedId: seed.id,
          raceId: race.id,
          windowStart,
          windowEnd,
          status: "ACTIVE",
        },
      });
      await prisma.race.update({
        where: { id: race.id },
        data: { seededBucketId: bucket.id },
      });
    }
    const databaseUrl = process.env.DATABASE_URL;
    const dbName = new URL(databaseUrl).pathname.slice(1);
    const runCli = async (extra = []) => {
      const { stdout } = await execFileAsync(
        process.execPath,
        ["scripts/repair-signup-seeded-cohort.js", "--date=2026-08-25", ...extra],
        { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl } },
      );
      const marker = "COHORT_REPORT=";
      return JSON.parse(stdout.slice(stdout.lastIndexOf(marker) + marker.length).trim());
    };
    const dry = await runCli(["--dry-run"]);
    assert.deepEqual(dry.missingBoth, [signup.user.id]);
    assert.equal(dry.commands.length, 2);
    await runCli(["--apply", `--confirm-database=${dbName}`]);
    const laterSignup = await makeUser("Later August 25 Cohort User");
    await prisma.user.update({
      where: { id: laterSignup.user.id },
      data: { createdAt: new Date("2026-08-25T15:00:00.000Z") },
    });
    await runCli(["--apply", `--confirm-database=${dbName}`]);
    assert.equal(
      await prisma.raceAdminCommand.count({
        where: { commandType: "HISTORICAL_COHORT_ENROLLMENT" },
      }),
      2,
    );
    const commands = await prisma.raceAdminCommand.findMany({
      where: { commandType: "HISTORICAL_COHORT_ENROLLMENT" },
    });
    for (const command of commands) {
      assert.deepEqual(
        command.payload.userIds.sort(),
        [signup.user.id, laterSignup.user.id].sort(),
        "pending command payload refreshes after a later audit finds another missing user",
      );
    }
  });
});
