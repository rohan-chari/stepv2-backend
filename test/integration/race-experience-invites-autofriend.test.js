const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  startServer,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");

const QUICK_FEATURE = "next_race_cta";
const TOURNAMENT_FEATURES = "tournaments,characters";
let server;
let nextUser = 0;

async function setFlag(key, value) {
  await prisma.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
  appSettings.bustCache();
}

async function user(name = "Runner", features) {
  const n = ++nextUser;
  const signIn = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `race-identity-link-${n}` },
    headers: features ? { "X-Client-Features": features } : {},
  });
  const body = await signIn.json();
  assert.equal(signIn.status, 200, JSON.stringify(body));
  const result = { id: body.user.id, token: body.sessionToken };
  const rename = await request(
    server.baseUrl,
    "PUT",
    "/auth/me/display-name",
    {
      token: result.token,
      body: { displayName: `${name}${n}` },
      headers: features ? { "X-Client-Features": features } : {},
    }
  );
  assert.equal(rename.status, 200, JSON.stringify(await rename.clone().json()));
  if (features) {
    await request(server.baseUrl, "GET", "/races", {
      token: result.token,
      headers: { "X-Client-Features": features },
    });
  }
  return result;
}

async function acceptedFriendship(left, right) {
  const sent = await request(server.baseUrl, "POST", "/friends/request", {
    token: left.token,
    body: { addresseeId: right.id },
  });
  const sentBody = await sent.json();
  assert.equal(sent.status, 201, JSON.stringify(sentBody));
  const friendshipId = sentBody.friendship.id;
  const accepted = await request(
    server.baseUrl,
    "PUT",
    `/friends/request/${friendshipId}`,
    { token: right.token, body: { accept: true } }
  );
  assert.equal(accepted.status, 200, JSON.stringify(await accepted.clone().json()));
  return friendshipId;
}

function quickBody(overrides = {}) {
  return {
    name: "Shared Quick Sprint",
    maxDurationDays: 2,
    buyInAmount: 0,
    payoutPreset: "TOP3_70_20_10",
    isPublic: true,
    maxParticipants: 10,
    powerupsEnabled: true,
    powerupStepInterval: 2000,
    creationSource: "QUICK_CREATE",
    startPolicy: "ON_MINIMUM_PARTICIPANTS",
    ...overrides,
  };
}

async function createQuick(owner) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    headers: { "X-Client-Features": QUICK_FEATURE },
    body: quickBody(),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const link = await request(
    server.baseUrl,
    "POST",
    `/races/${body.race.id}/share-link`,
    { token: owner.token }
  );
  const linkBody = await link.json();
  assert.equal(link.status, 201, JSON.stringify(linkBody));
  return { raceId: body.race.id, shareToken: linkBody.shareToken };
}

async function joinShared(joiner, shareToken) {
  return request(
    server.baseUrl,
    "POST",
    `/races/share/${shareToken}/join`,
    {
      token: joiner.token,
      headers: { "X-Client-Features": QUICK_FEATURE },
    }
  );
}

async function pairFriendship(leftId, rightId) {
  return prisma.friendship.findFirst({
    where: {
      OR: [
        { requesterId: leftId, addresseeId: rightId },
        { requesterId: rightId, addresseeId: leftId },
      ],
    },
  });
}

async function pairFriendships(leftId, rightId) {
  return prisma.friendship.findMany({
    where: {
      OR: [
        { requesterId: leftId, addresseeId: rightId },
        { requesterId: rightId, addresseeId: leftId },
      ],
    },
    orderBy: { id: "asc" },
  });
}

function deferredSignal() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pairSuppression(leftId, rightId) {
  const [userAId, userBId] = [leftId, rightId].sort();
  return prisma.friendshipAutoLinkSuppression.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });
}

async function createOrdinaryRace(owner, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    body: {
      name: "Invite Contract Race",
      maxDurationDays: 4,
      targetSteps: 50_000,
      ...overrides,
    },
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.race;
}

describe("race invite summaries + quick-share automatic friendship — locked HTTP contract", () => {
  before(async () => {
    server = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
    });
  });

  after(async () => {
    await setFlag("quickCreateRaceCtaEnabled", false);
    await setFlag("quickRaceShareAutoFriendEnabled", false);
    await setFlag("tournamentsEnabled", true);
    await setFlag("fundedPrizePoolsEnabled", true);
    await server.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextUser = 0;
    await setFlag("quickCreateRaceCtaEnabled", true);
    await setFlag("quickRaceShareAutoFriendEnabled", false);
    await setFlag("tournamentsEnabled", true);
    await setFlag("fundedPrizePoolsEnabled", false);
  });

  it("adds exact race invite ordering timestamps while preserving the frozen list shape", async () => {
    const owner = await user("Owner");
    const invitee = await user("Invitee");
    await acceptedFriendship(owner, invitee);
    const race = await createOrdinaryRace(owner, {
      scheduledStartAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    });
    const invite = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/invite`,
      { token: owner.token, body: { inviteeIds: [invitee.id] } }
    );
    assert.equal(invite.status, 200, JSON.stringify(await invite.clone().json()));

    const response = await request(server.baseUrl, "GET", "/races", {
      token: invitee.token,
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(Object.keys(body).sort(), ["active", "completed", "pending"]);
    const summary = body.pending.find((item) => item.id === race.id);
    assert.ok(summary);
    assert.match(summary.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(summary.scheduledStartAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(summary.myInviteExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(summary.myStatus, "INVITED");

    const decision = await request(
      server.baseUrl,
      "PUT",
      `/races/${race.id}/respond`,
      { token: invitee.token, body: { accept: false } }
    );
    const decisionBody = await decision.json();
    assert.equal(decision.status, 200, JSON.stringify(decisionBody));
    assert.equal("participant" in decisionBody, true);
  });

  it("serializes optional race scheduling and invite expiry as null, never malformed", async () => {
    const owner = await user("Owner");
    const invitee = await user("Invitee");
    await acceptedFriendship(owner, invitee);
    const race = await createOrdinaryRace(owner);
    const invite = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/invite`,
      { token: owner.token, body: { inviteeIds: [invitee.id] } }
    );
    assert.equal(invite.status, 200);
    await prisma.raceParticipant.update({
      where: { raceId_userId: { raceId: race.id, userId: invitee.id } },
      data: { inviteExpiresAt: null },
    });

    const body = await (
      await request(server.baseUrl, "GET", "/races", { token: invitee.token })
    ).json();
    const summary = body.pending.find((item) => item.id === race.id);
    assert.equal(summary.scheduledStartAt, null);
    assert.equal(summary.myInviteExpiresAt, null);
  });

  it("adds tournament createdAt + creator to invite summaries and keeps respond unchanged", async () => {
    const creator = await user("Creator", TOURNAMENT_FEATURES);
    const invitee = await user("Invitee", TOURNAMENT_FEATURES);
    await acceptedFriendship(creator, invitee);
    const response = await request(server.baseUrl, "POST", "/tournaments", {
      token: creator.token,
      headers: { "X-Client-Features": TOURNAMENT_FEATURES },
      body: {
        name: "Invitation Cup",
        bracketSize: 4,
        matchupDurationDays: 2,
        buyInAmount: 0,
        isPublic: false,
        inviteeIds: [invitee.id],
      },
    });
    const created = await response.json();
    assert.equal(response.status, 201, JSON.stringify(created));

    const creatorList = await request(server.baseUrl, "GET", "/races", {
      token: creator.token,
      headers: { "X-Client-Features": TOURNAMENT_FEATURES },
    });
    const creatorBody = await creatorList.json();
    assert.equal(creatorList.status, 200, JSON.stringify(creatorBody));
    const acceptedSummary = creatorBody.tournaments.find(
      (item) => item.id === created.tournament.id
    );
    assert.ok(acceptedSummary);
    assert.equal(acceptedSummary.myStatus, "ACCEPTED");
    assert.equal("createdAt" in acceptedSummary, false);
    assert.equal("creator" in acceptedSummary, false);

    const list = await request(server.baseUrl, "GET", "/races", {
      token: invitee.token,
      headers: { "X-Client-Features": TOURNAMENT_FEATURES },
    });
    const body = await list.json();
    assert.equal(list.status, 200, JSON.stringify(body));
    const summary = body.tournaments.find(
      (item) => item.id === created.tournament.id
    );
    assert.ok(summary);
    assert.match(summary.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(summary.creator, {
      id: creator.id,
      displayName: `Creator1`,
      profilePhotoUrl: null,
    });

    const decision = await request(
      server.baseUrl,
      "PUT",
      `/tournaments/${created.tournament.id}/respond`,
      {
        token: invitee.token,
        headers: { "X-Client-Features": TOURNAMENT_FEATURES },
        body: { accept: false },
      }
    );
    const decisionBody = await decision.json();
    assert.equal(decision.status, 200, JSON.stringify(decisionBody));
    assert.equal("tournament" in decisionBody, true);
  });

  it("flag off keeps successful share join friendship-free and preserves response shape", async () => {
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { raceId, shareToken } = await createQuick(creator);
    const response = await joinShared(joiner, shareToken);
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.deepEqual(Object.keys(body).sort(), ["participant", "raceId"]);
    assert.equal(body.raceId, raceId);
    assert.equal(await pairFriendship(creator.id, joiner.id), null);
  });

  it("flag on creates an accepted friendship atomically with quick-share participation", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { raceId, shareToken } = await createQuick(creator);
    const response = await joinShared(joiner, shareToken);
    const body = await response.json();
    assert.equal(response.status, 201, JSON.stringify(body));
    assert.equal(body.raceId, raceId);
    const friendship = await pairFriendship(creator.id, joiner.id);
    assert.equal(friendship.status, "ACCEPTED");
    assert.equal(
      await prisma.raceParticipant.count({
        where: { raceId, userId: joiner.id, status: "ACCEPTED" },
      }),
      1
    );
  });

  it("runs share-join post-commit work only after participant and friendship are visible on another connection", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { raceId, shareToken } = await createQuick(creator);
    let observations = 0;
    const observingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      // Select the injected share-join command while leaving its durable seam
      // untouched. enqueueRaceResolution is a real post-commit dependency.
      beforeAutoFriendWrite: async () => {},
      enqueueRaceResolution: async ({ raceId: observedRaceId, userId }) => {
        observations += 1;
        assert.equal(observedRaceId, raceId);
        assert.equal(userId, joiner.id);
        assert.equal(
          await prisma.raceParticipant.count({
            where: { raceId, userId: joiner.id, status: "ACCEPTED" },
          }),
          1,
          "post-commit work must see the committed participant"
        );
        assert.equal(
          (await pairFriendship(creator.id, joiner.id))?.status,
          "ACCEPTED",
          "post-commit work must see the committed friendship"
        );
      },
    });
    try {
      const response = await request(
        observingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
      assert.equal(observations, 1);
    } finally {
      await observingServer.close();
    }
  });

  it("keeps the participant and friendship committed when share-join post-commit work fails", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { raceId, shareToken } = await createQuick(creator);
    const failingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoFriendWrite: async () => {},
      enqueueRaceResolution: async () => {
        throw new Error("injected post-commit failure");
      },
    });
    try {
      const response = await request(
        failingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      assert.equal(response.status, 500);
      assert.equal(
        await prisma.raceParticipant.count({
          where: { raceId, userId: joiner.id, status: "ACCEPTED" },
        }),
        1
      );
      assert.equal((await pairFriendship(creator.id, joiner.id))?.status, "ACCEPTED");
    } finally {
      await failingServer.close();
    }
  });

  it("serializes a quick-share auto-link against an opposite-direction manual request", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { shareToken } = await createQuick(creator);
    const autoWriteEntered = deferredSignal();
    const releaseAutoWrite = deferredSignal();
    const racingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoFriendWrite: async () => {
        autoWriteEntered.resolve();
        await releaseAutoWrite.promise;
      },
    });
    try {
      const shareJoin = request(
        racingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      await autoWriteEntered.promise;
      const manualSend = request(
        racingServer.baseUrl,
        "POST",
        "/friends/request",
        { token: joiner.token, body: { addresseeId: creator.id } }
      );
      await delay(75);
      releaseAutoWrite.resolve();
      const [joined, sent] = await Promise.all([shareJoin, manualSend]);
      assert.equal(joined.status, 201, JSON.stringify(await joined.clone().json()));
      assert.equal(sent.status, 409, JSON.stringify(await sent.clone().json()));
      const rows = await pairFriendships(creator.id, joiner.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "ACCEPTED");
    } finally {
      releaseAutoWrite.resolve();
      await racingServer.close();
    }
  });

  it("serializes referral auto-link against an opposite-direction manual request", async () => {
    const referrer = await user("Referrer", QUICK_FEATURE);
    const referee = await user("Referee", QUICK_FEATURE);
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: referrer.token,
    });
    const { code } = await link.json();
    const autoWriteEntered = deferredSignal();
    const releaseAutoWrite = deferredSignal();
    const racingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoFriendWrite: async () => {
        autoWriteEntered.resolve();
        await releaseAutoWrite.promise;
      },
    });
    try {
      const redeem = request(
        racingServer.baseUrl,
        "POST",
        "/referrals/redeem",
        { token: referee.token, body: { referralCode: code } }
      );
      await autoWriteEntered.promise;
      const manualSend = request(
        racingServer.baseUrl,
        "POST",
        "/friends/request",
        { token: referee.token, body: { addresseeId: referrer.id } }
      );
      await delay(75);
      releaseAutoWrite.resolve();
      const [redeemed, sent] = await Promise.all([redeem, manualSend]);
      assert.equal(redeemed.status, 200, JSON.stringify(await redeemed.clone().json()));
      assert.deepEqual(await redeemed.json(), { attributed: true });
      assert.equal(sent.status, 409, JSON.stringify(await sent.clone().json()));
      const rows = await pairFriendships(referrer.id, referee.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "ACCEPTED");
    } finally {
      releaseAutoWrite.resolve();
      await racingServer.close();
    }
  });

  it("serializes decline suppression ahead of an overlapping quick-share auto-link", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    const { shareToken } = await createQuick(creator);
    const declineWriteEntered = deferredSignal();
    const releaseDeclineWrite = deferredSignal();
    const autoWriteEntered = deferredSignal();
    const releaseAutoWrite = deferredSignal();
    const racingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoLinkSuppressionWrite: async () => {
        declineWriteEntered.resolve();
        await releaseDeclineWrite.promise;
      },
      beforeAutoFriendWrite: async () => {
        autoWriteEntered.resolve();
        await releaseAutoWrite.promise;
      },
    });
    try {
      const decline = request(
        racingServer.baseUrl,
        "PUT",
        `/friends/request/${friendshipId}`,
        { token: joiner.token, body: { accept: false } }
      );
      await declineWriteEntered.promise;
      const shareJoin = request(
        racingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      const autoReachedWrite = await Promise.race([
        autoWriteEntered.promise.then(() => true),
        delay(100).then(() => false),
      ]);
      releaseDeclineWrite.resolve();
      const declined = await decline;
      assert.equal(declined.status, 200, JSON.stringify(await declined.clone().json()));
      if (autoReachedWrite) releaseAutoWrite.resolve();
      const joined = await shareJoin;
      assert.equal(joined.status, 201, JSON.stringify(await joined.clone().json()));
      const rows = await pairFriendships(creator.id, joiner.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "DECLINED");
      assert.ok(await pairSuppression(creator.id, joiner.id));
    } finally {
      releaseDeclineWrite.resolve();
      releaseAutoWrite.resolve();
      await racingServer.close();
    }
  });

  it("serializes removal suppression ahead of an overlapping referral auto-link", async () => {
    const referrer = await user("Referrer", QUICK_FEATURE);
    const referee = await user("Referee", QUICK_FEATURE);
    const friendshipId = await acceptedFriendship(referrer, referee);
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: referrer.token,
    });
    const { code } = await link.json();
    const removalWriteEntered = deferredSignal();
    const releaseRemovalWrite = deferredSignal();
    const autoWriteEntered = deferredSignal();
    const releaseAutoWrite = deferredSignal();
    const racingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoLinkSuppressionWrite: async () => {
        removalWriteEntered.resolve();
        await releaseRemovalWrite.promise;
      },
      beforeAutoFriendWrite: async () => {
        autoWriteEntered.resolve();
        await releaseAutoWrite.promise;
      },
    });
    try {
      const removal = request(
        racingServer.baseUrl,
        "DELETE",
        `/friends/${friendshipId}`,
        { token: referrer.token }
      );
      await removalWriteEntered.promise;
      const redeem = request(
        racingServer.baseUrl,
        "POST",
        "/referrals/redeem",
        { token: referee.token, body: { referralCode: code } }
      );
      const autoReachedWrite = await Promise.race([
        autoWriteEntered.promise.then(() => true),
        delay(100).then(() => false),
      ]);
      releaseRemovalWrite.resolve();
      const removed = await removal;
      assert.equal(removed.status, 200, JSON.stringify(await removed.clone().json()));
      if (autoReachedWrite) releaseAutoWrite.resolve();
      const redeemed = await redeem;
      assert.equal(redeemed.status, 200, JSON.stringify(await redeemed.clone().json()));
      assert.deepEqual(await redeemed.json(), { attributed: true });
      assert.equal((await pairFriendships(referrer.id, referee.id)).length, 0);
      assert.ok(await pairSuppression(referrer.id, referee.id));
    } finally {
      releaseRemovalWrite.resolve();
      releaseAutoWrite.resolve();
      await racingServer.close();
    }
  });

  it("serializes explicit manual acceptance behind an overlapping quick-share auto-link", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    const { shareToken } = await createQuick(creator);
    const autoWriteEntered = deferredSignal();
    const releaseAutoWrite = deferredSignal();
    const racingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoFriendWrite: async () => {
        autoWriteEntered.resolve();
        await releaseAutoWrite.promise;
      },
    });
    try {
      const shareJoin = request(
        racingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      await autoWriteEntered.promise;
      const acceptance = request(
        racingServer.baseUrl,
        "PUT",
        `/friends/request/${friendshipId}`,
        { token: joiner.token, body: { accept: true } }
      );
      await delay(75);
      releaseAutoWrite.resolve();
      const [joined, accepted] = await Promise.all([shareJoin, acceptance]);
      assert.equal(joined.status, 201, JSON.stringify(await joined.clone().json()));
      assert.equal(accepted.status, 409, JSON.stringify(await accepted.clone().json()));
      const rows = await pairFriendships(creator.id, joiner.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "ACCEPTED");
    } finally {
      releaseAutoWrite.resolve();
      await racingServer.close();
    }
  });

  it("upgrades reverse pending, no-ops accepted, and handles concurrent retries without duplicate pairs", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const pending = await request(server.baseUrl, "POST", "/friends/request", {
      token: joiner.token,
      body: { addresseeId: creator.id },
    });
    assert.equal(pending.status, 201);
    const { shareToken } = await createQuick(creator);
    const concurrent = await Promise.all([
      joinShared(joiner, shareToken),
      joinShared(joiner, shareToken),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [201, 400]);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "ACCEPTED");
    assert.equal(
      await prisma.friendship.count({
        where: {
          OR: [
            { requesterId: creator.id, addresseeId: joiner.id },
            { requesterId: joiner.id, addresseeId: creator.id },
          ],
        },
      }),
      1
    );
  });

  it("decline creates durable suppression and quick-share never restores the friendship", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    const declined = await request(
      server.baseUrl,
      "PUT",
      `/friends/request/${friendshipId}`,
      { token: joiner.token, body: { accept: false } }
    );
    assert.equal(declined.status, 200);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "DECLINED");
    assert.ok(await pairSuppression(creator.id, joiner.id));

    const { shareToken } = await createQuick(creator);
    assert.equal((await joinShared(joiner, shareToken)).status, 201);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "DECLINED");
  });

  it("pending plus suppression gives suppression precedence over automatic upgrade", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    assert.equal(
      (
        await request(
          server.baseUrl,
          "PUT",
          `/friends/request/${friendshipId}`,
          { token: joiner.token, body: { accept: false } }
        )
      ).status,
      200
    );
    assert.equal(
      (
        await request(server.baseUrl, "POST", "/friends/request", {
          token: creator.token,
          body: { addresseeId: joiner.id },
        })
      ).status,
      201
    );
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "PENDING");
    assert.ok(await pairSuppression(creator.id, joiner.id));

    const { shareToken } = await createQuick(creator);
    assert.equal((await joinShared(joiner, shareToken)).status, 201);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "PENDING");
  });

  it("friend removal writes suppression and a later quick-share join remains friendship-free", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const friendshipId = await acceptedFriendship(creator, joiner);
    const removed = await request(
      server.baseUrl,
      "DELETE",
      `/friends/${friendshipId}`,
      { token: creator.token }
    );
    assert.equal(removed.status, 200);
    assert.equal(await pairFriendship(creator.id, joiner.id), null);
    assert.ok(await pairSuppression(creator.id, joiner.id));

    const { shareToken } = await createQuick(creator);
    assert.equal((await joinShared(joiner, shareToken)).status, 201);
    assert.equal(await pairFriendship(creator.id, joiner.id), null);
  });

  it("decline → manual resend stays suppressed from quick-share until explicit manual acceptance", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      token: joiner.token,
      body: { accept: false },
    });
    await request(server.baseUrl, "POST", "/friends/request", {
      token: creator.token,
      body: { addresseeId: joiner.id },
    });

    const { shareToken } = await createQuick(creator);
    assert.equal((await joinShared(joiner, shareToken)).status, 201);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "PENDING");

    const accepted = await request(
      server.baseUrl,
      "PUT",
      `/friends/request/${friendshipId}`,
      { token: joiner.token, body: { accept: true } }
    );
    assert.equal(accepted.status, 200);
    assert.equal((await pairFriendship(creator.id, joiner.id)).status, "ACCEPTED");
    assert.ok(await pairSuppression(creator.id, joiner.id));
  });

  it("decline → manual resend also suppresses referral auto-link; explicit acceptance still wins", async () => {
    const referrer = await user("Referrer", QUICK_FEATURE);
    const referee = await user("Referee", QUICK_FEATURE);
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: referrer.token,
      body: { addresseeId: referee.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    await request(server.baseUrl, "PUT", `/friends/request/${friendshipId}`, {
      token: referee.token,
      body: { accept: false },
    });
    await request(server.baseUrl, "POST", "/friends/request", {
      token: referrer.token,
      body: { addresseeId: referee.id },
    });

    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: referrer.token,
    });
    const { code } = await link.json();
    const redeemed = await request(
      server.baseUrl,
      "POST",
      "/referrals/redeem",
      { token: referee.token, body: { referralCode: code } }
    );
    assert.deepEqual(await redeemed.json(), { attributed: true });
    assert.equal((await pairFriendship(referrer.id, referee.id)).status, "PENDING");
    assert.ok(await pairSuppression(referrer.id, referee.id));

    const accepted = await request(
      server.baseUrl,
      "PUT",
      `/friends/request/${friendshipId}`,
      { token: referee.token, body: { accept: true } }
    );
    assert.equal(accepted.status, 200);
    assert.equal((await pairFriendship(referrer.id, referee.id)).status, "ACCEPTED");
  });

  it("referral attribution overlapping an accepted pair converges without duplicate friendship rows", async () => {
    const referrer = await user("Referrer", QUICK_FEATURE);
    const referee = await user("Referee", QUICK_FEATURE);
    await acceptedFriendship(referrer, referee);
    const link = await request(server.baseUrl, "POST", "/referrals/link", {
      token: referrer.token,
    });
    const { code } = await link.json();
    const redeemed = await request(
      server.baseUrl,
      "POST",
      "/referrals/redeem",
      { token: referee.token, body: { referralCode: code } }
    );
    assert.deepEqual(await redeemed.json(), { attributed: true });
    assert.equal((await pairFriendship(referrer.id, referee.id)).status, "ACCEPTED");
    assert.equal(
      await prisma.friendship.count({
        where: {
          OR: [
            { requesterId: referrer.id, addresseeId: referee.id },
            { requesterId: referee.id, addresseeId: referrer.id },
          ],
        },
      }),
      1
    );
  });

  it("cannot create a self-friendship through the creator's own share token", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const { shareToken } = await createQuick(creator);
    const response = await joinShared(creator, shareToken);
    assert.equal(response.status, 400);
    assert.equal(
      await prisma.friendship.count({
        where: { requesterId: creator.id, addresseeId: creator.id },
      }),
      0
    );
  });

  it("an injected suppression failure rolls back a decline", async () => {
    const requester = await user("Requester");
    const addressee = await user("Addressee");
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token,
      body: { addresseeId: addressee.id },
    });
    const friendshipId = (await sent.json()).friendship.id;
    const failingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoLinkSuppressionWrite: async () => {
        throw new Error("injected suppression failure");
      },
    });
    try {
      const response = await request(
        failingServer.baseUrl,
        "PUT",
        `/friends/request/${friendshipId}`,
        { token: addressee.token, body: { accept: false } }
      );
      assert.equal(response.status, 500);
      assert.equal((await pairFriendship(requester.id, addressee.id)).status, "PENDING");
      assert.equal(await pairSuppression(requester.id, addressee.id), null);
    } finally {
      await failingServer.close();
    }
  });

  it("an injected suppression failure rolls back friend removal", async () => {
    const first = await user("First");
    const second = await user("Second");
    const friendshipId = await acceptedFriendship(first, second);
    const failingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoLinkSuppressionWrite: async () => {
        throw new Error("injected suppression failure");
      },
    });
    try {
      const response = await request(
        failingServer.baseUrl,
        "DELETE",
        `/friends/${friendshipId}`,
        { token: first.token }
      );
      assert.equal(response.status, 500);
      assert.equal((await pairFriendship(first.id, second.id)).status, "ACCEPTED");
      assert.equal(await pairSuppression(first.id, second.id), null);
    } finally {
      await failingServer.close();
    }
  });

  it("public browse join and non-quick share join never auto-friend", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const publicJoiner = await user("Public", QUICK_FEATURE);
    const shareJoiner = await user("Share", QUICK_FEATURE);

    const publicRace = await createOrdinaryRace(creator, { isPublic: true });
    const publicJoin = await request(
      server.baseUrl,
      "POST",
      `/races/${publicRace.id}/join`,
      { token: publicJoiner.token }
    );
    assert.equal(publicJoin.status, 201, JSON.stringify(await publicJoin.clone().json()));
    assert.equal(await pairFriendship(creator.id, publicJoiner.id), null);

    const shareLink = await request(
      server.baseUrl,
      "POST",
      `/races/${publicRace.id}/share-link`,
      { token: creator.token }
    );
    const { shareToken } = await shareLink.json();
    const shareJoin = await joinShared(shareJoiner, shareToken);
    assert.equal(shareJoin.status, 201, JSON.stringify(await shareJoin.clone().json()));
    assert.equal(await pairFriendship(creator.id, shareJoiner.id), null);
  });

  it("an injected friendship failure rolls back the participant join", async () => {
    await setFlag("quickRaceShareAutoFriendEnabled", true);
    const creator = await user("Creator", QUICK_FEATURE);
    const joiner = await user("Joiner", QUICK_FEATURE);
    const { raceId, shareToken } = await createQuick(creator);

    const failingServer = await startServer({
      verifyAppleIdentityToken: async (token) => ({
        sub: token,
        email: `${token}@example.com`,
      }),
      beforeAutoFriendWrite: async () => {
        throw new Error("injected friendship failure");
      },
    });
    try {
      const response = await request(
        failingServer.baseUrl,
        "POST",
        `/races/share/${shareToken}/join`,
        {
          token: joiner.token,
          headers: { "X-Client-Features": QUICK_FEATURE },
        }
      );
      assert.equal(response.status, 500);
      assert.equal(
        await prisma.raceParticipant.count({
          where: { raceId, userId: joiner.id },
        }),
        0
      );
      assert.equal(await pairFriendship(creator.id, joiner.id), null);
    } finally {
      await failingServer.close();
    }
  });
});
