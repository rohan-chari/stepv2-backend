const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { after, before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  prisma,
  request,
  startServer,
} = require("./setup");

const GLOBAL_FEATURES = {
  "X-Client-Features": "referral_contest_v1,referral_contest_global_v1",
};
const POWERUPS5 = {
  "X-Client-Features": "characters,team_races,powerups2,powerups3,powerups4,powerups5",
};
const AMENDMENT_REASON =
  "Replace internal interval notation with equivalent plain language";
const CHECK_TIME = new Date("2026-08-29T16:00:00.000Z");

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function v1Rules(contest) {
  const startsAt = new Date(contest.startsAt).toISOString();
  const endsAt = new Date(contest.endsAt).toISOString();
  const standardTemplateVersion = "bara-account-v1";
  const material = {
    slug: contest.slug,
    title: contest.title,
    startsAt,
    endsAt,
    coinPrize: contest.coinPrize,
    eligibilityMode: "BARA_ACCOUNT",
    standardTemplateVersion,
  };
  const version = `${standardTemplateVersion}-${sha256(material).slice(0, 24)}`;
  const sections = [
    {
      heading: "Who can join",
      body: "Any signed-in Bara user permitted under Bara's Terms may join. One entry is allowed per Bara account/provider identity. No purchase necessary. Duplicate accounts controlled by one person are subject to fraud review.",
    },
    {
      heading: "Contest window",
      body: `The contest runs from ${startsAt} through ${endsAt} UTC. Referrals count only when they qualify after you join and during the half-open contest window [startsAt, endsAt).`,
    },
    {
      heading: "How to win",
      body: "Join and accept these rules; share your unique Bara invite; your friend signs up with it; your friend completes a qualifying race with another real player during the contest window; the eligible entrant with the most verified completed referrals wins.",
    },
    {
      heading: "Prize",
      body: `The fixed prize is ${contest.coinPrize.toLocaleString("en-US")} Bara coins. Bara coins have no monetary value and cannot be sold, transferred, withdrawn, or used outside Bara.`,
    },
    {
      heading: "Ranking and review",
      body: "The leaderboard is provisional until final review. Ties go first to the entrant who earliest reached the final verified referral count, then to the entrant with the lexicographically smallest stable entrant ID. If nobody has a verified completed referral, there is no winner. Bots, self-referrals, duplicate accounts, and dummy-account coordination are prohibited.",
    },
    {
      heading: "Platforms and sponsor",
      body: "Sponsored by Bara. Apple and Google are not sponsors, administrators, endorsers, or involved in this contest. Optional social follows or posts do not affect the contest.",
    },
  ];
  return { version, sections, hash: sha256({ version, sections }) };
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

async function makeFriends(a, b) {
  const sent = await read(await request(server.baseUrl, "POST", "/friends/request", {
    token: a.token,
    body: { addresseeId: b.user.id },
  }));
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  const accepted = await request(
    server.baseUrl,
    "PUT",
    `/friends/request/${sent.body.friendship.id}`,
    { token: b.token, body: { accept: true } },
  );
  assert.equal(accepted.status, 200);
}

async function createActiveRace(users) {
  const [creator, ...others] = users;
  for (const other of others) await makeFriends(creator, other);
  const created = await read(await request(server.baseUrl, "POST", "/races", {
    token: creator.token,
    headers: POWERUPS5,
    body: {
      name: "Hitchhike final target integration",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 50000,
    },
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const raceId = created.body.race.id;
  const invited = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    token: creator.token,
    headers: POWERUPS5,
    body: { inviteeIds: others.map((user) => user.user.id) },
  });
  assert.equal(invited.status, 200, await invited.clone().text());
  for (const other of others) {
    const joined = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: other.token,
      headers: POWERUPS5,
      body: { accept: true },
    });
    assert.equal(joined.status, 200);
  }
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  if (race.status !== "ACTIVE") {
    const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: creator.token,
      headers: POWERUPS5,
    });
    assert.equal(started.status, 200);
  }
  await prisma.racePowerupEvent.updateMany({
    where: { raceId, eventType: "RACE_STARTED" },
    data: { createdAt: new Date(CHECK_TIME.getTime() - 60_000) },
  });
  return raceId;
}

async function createActiveTeamRace({ creator, teamA, teamB }) {
  const others = [...teamA, ...teamB].filter((user) => user.user.id !== creator.user.id);
  for (const other of others) await makeFriends(creator, other);
  await prisma.user.updateMany({
    where: { id: { in: others.map((user) => user.user.id) } },
    data: { clientFeatures: ["team_races", "powerups5"] },
  });
  const created = await read(await request(server.baseUrl, "POST", "/races", {
    token: creator.token,
    headers: POWERUPS5,
    body: {
      name: "Hitchhike final target team integration",
      maxDurationDays: 7,
      isPublic: true,
      isTeamRace: true,
      teamSize: 2,
      powerupsEnabled: true,
      powerupStepInterval: 50000,
    },
  }));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const raceId = created.body.race.id;
  const invited = await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    token: creator.token,
    headers: POWERUPS5,
    body: { inviteeIds: others.map((user) => user.user.id) },
  });
  assert.equal(invited.status, 200, await invited.clone().text());
  for (const other of others) {
    const team = teamA.some((user) => user.user.id === other.user.id)
      ? "TEAM_A"
      : "TEAM_B";
    const joined = await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      token: other.token,
      headers: POWERUPS5,
      body: { accept: true, team },
    });
    assert.equal(joined.status, 200, await joined.clone().text());
  }
  const race = await prisma.race.findUnique({ where: { id: raceId } });
  if (race.status !== "ACTIVE") {
    const started = await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: creator.token,
      headers: POWERUPS5,
    });
    assert.equal(started.status, 200, await started.clone().text());
  }
  await prisma.racePowerupEvent.updateMany({
    where: { raceId, eventType: "RACE_STARTED" },
    data: { createdAt: new Date(CHECK_TIME.getTime() - 60_000) },
  });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findFirst({ where: { raceId, userId } });
}

async function giveHeld(raceId, userId, type, overrides = {}) {
  const owner = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: owner.id,
      userId,
      type,
      rarity: "RARE",
      status: "HELD",
      ...overrides,
    },
  });
}

async function use(user, raceId, itemId, targetUserId) {
  return request(server.baseUrl, "POST", `/races/${raceId}/powerups/${itemId}/use`, {
    token: user.token,
    headers: POWERUPS5,
    body: targetUserId ? { targetUserId } : {},
  });
}

async function activate(user, raceId, type) {
  const item = await giveHeld(raceId, user.user.id, type);
  const response = await use(user, raceId, item.id);
  assert.equal(response.status, 200, await response.clone().text());
  return prisma.raceActiveEffect.findFirst({
    where: { raceId, targetUserId: user.user.id, type, status: "ACTIVE" },
  });
}

async function systemMessages(user, raceId, query = "") {
  const separator = query ? "&" : "?";
  return read(await request(
    server.baseUrl,
    "GET",
    `/races/${raceId}/messages${query}${separator}kind=SYSTEM`,
    { token: user.token, headers: POWERUPS5 },
  ));
}

let server;
let admin;

describe("referral rules, final-target Hitchhike, and activity clarity", () => {
  before(async () => {
    assert.match(
      process.env.DATABASE_URL || "",
      /(?:-integration|_test)(?:\?|$)/,
      "this suite requires the dedicated integration database",
    );
    process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION = "1";
    process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1 =
      "rules-amendment-integration-only-secret";
    delete process.env.REDIS_URL;
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Rules Admin" });
    server = await startServer({
      now: () => new Date(CHECK_TIME),
      random: () => 0,
      isAdminUser: (user) => user?.id === admin.user.id,
      appSettings: { async getFlag() { return false; } },
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
    admin = await createTestUser({ displayName: "Rules Admin" });
  });

  after(async () => {
    await server?.close();
    delete process.env.GIVEAWAY_ENTRANT_HMAC_ACTIVE_VERSION;
    delete process.env.GIVEAWAY_ENTRANT_HMAC_SECRET_V1;
  });

  it("generates v2 plain-language rules and atomically amends an exact published v1 predecessor", async () => {
    const created = await read(await request(server.baseUrl, "POST", "/admin/giveaways", {
      token: admin.token,
      headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
      body: {
        slug: "plain-language-window",
        title: "Plain Language Referral Trail",
        startsAt: "2026-08-01T04:00:00.000Z",
        endsAt: "2026-10-01T00:00:00.000Z",
        coinPrize: 5000,
        bannerMessage: "Bring your crew to the referral trail.",
        eligibilityMode: "BARA_ACCOUNT",
      },
    }));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.match(created.body.contest.rules.version, /^bara-account-v1-/);
    const contestWindow = created.body.contest.rules.sections.find(
      (section) => section.heading === "Contest window",
    );
    assert.equal(
      contestWindow.body,
      "The contest runs from 2026-08-01T04:00:00.000Z through 2026-10-01T00:00:00.000Z. These server timestamps are stored in UTC. A referral counts only if it qualifies at or after you join, at or after the contest start, and before the contest end.",
    );
    assert.doesNotMatch(canonicalJson(created.body.contest.rules.sections), /\[startsAt, endsAt\)/);

    const published = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${created.body.contest.id}/publish`,
      {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: { revision: created.body.contest.revision },
      },
    ));
    assert.equal(published.status, 200, JSON.stringify(published.body));

    const stored = await prisma.giveawayContest.findUnique({
      where: { id: created.body.contest.id },
    });
    const predecessor = v1Rules(stored);
    await prisma.giveawayContest.update({
      where: { id: stored.id },
      data: {
        rulesVersion: predecessor.version,
        rulesHash: predecessor.hash,
        rulesSections: predecessor.sections,
      },
    });

    const oldEntrant = await createTestUser({ displayName: "OldEntrant" });
    const oldEntry = await read(await request(
      server.baseUrl,
      "POST",
      `/giveaways/${stored.slug}/entries`,
      {
        token: oldEntrant.token,
        headers: GLOBAL_FEATURES,
        body: { rulesVersion: predecessor.version, rulesAccepted: true },
      },
    ));
    assert.equal(oldEntry.status, 201, JSON.stringify(oldEntry.body));

    const unauthenticated = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision,
          templateVersion: "bara-account-v2",
          reason: AMENDMENT_REASON,
        },
      },
    ));
    assert.equal(unauthenticated.status, 401);
    const forbidden = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: oldEntrant.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision,
          templateVersion: "bara-account-v2",
          reason: AMENDMENT_REASON,
        },
      },
    ));
    assert.equal(forbidden.status, 403);

    const invalid = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision,
          templateVersion: "bara-account-v2",
          reason: "Change the prize too",
        },
      },
    ));
    assert.equal(invalid.status, 422);
    assert.equal(invalid.body.code, "INVALID_RULES_AMENDMENT");

    await prisma.giveawayContest.update({
      where: { id: stored.id },
      data: { rulesHash: `corrupt-${predecessor.hash}` },
    });
    const corruptPredecessor = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision,
          templateVersion: "bara-account-v2",
          reason: AMENDMENT_REASON,
        },
      },
    ));
    assert.equal(corruptPredecessor.status, 422);
    assert.equal(corruptPredecessor.body.code, "INVALID_RULES_AMENDMENT");
    await prisma.giveawayContest.update({
      where: { id: stored.id },
      data: { rulesHash: predecessor.hash, lifecycleStatus: "DRAFT" },
    });
    const invalidLifecycle = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision,
          templateVersion: "bara-account-v2",
          reason: AMENDMENT_REASON,
        },
      },
    ));
    assert.equal(invalidLifecycle.status, 409);
    assert.equal(invalidLifecycle.body.code, "INVALID_TRANSITION");
    await prisma.giveawayContest.update({
      where: { id: stored.id },
      data: { lifecycleStatus: "PUBLISHED" },
    });

    const stale = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: admin.token,
        headers: { ...GLOBAL_FEATURES, "Idempotency-Key": crypto.randomUUID() },
        body: {
          revision: published.body.contest.revision - 1,
          templateVersion: "bara-account-v2",
          reason: AMENDMENT_REASON,
        },
      },
    ));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "REVISION_CONFLICT");

    const amendmentKey = crypto.randomUUID();
    const competingAmendmentKey = crypto.randomUUID();
    const amendmentBody = {
      revision: published.body.contest.revision,
      templateVersion: "bara-account-v2",
      reason: AMENDMENT_REASON,
    };
    const competingResponses = await Promise.all(
      [amendmentKey, competingAmendmentKey].map(async (key) => ({
        key,
        response: await read(await request(
          server.baseUrl,
          "POST",
          `/admin/giveaways/${stored.id}/amend-standard-rules`,
          {
          token: admin.token,
          headers: { "Idempotency-Key": key },
            body: amendmentBody,
          },
        )),
      })),
    );
    assert.deepEqual(
      competingResponses.map(({ response }) => response.status).sort(),
      [200, 409],
    );
    const winningAmendment = competingResponses.find(
      ({ response }) => response.status === 200,
    );
    const amended = winningAmendment.response;
    assert.equal(amended.status, 200, JSON.stringify(amended.body));
    assert.equal(amended.body.contest.revision, published.body.contest.revision + 1);
    assert.match(amended.body.contest.rules.version, /^bara-account-v1-/);
    assert.notEqual(amended.body.contest.rules.sha256, predecessor.hash);

    const replay = await read(await request(
      server.baseUrl,
      "POST",
      `/admin/giveaways/${stored.id}/amend-standard-rules`,
      {
        token: admin.token,
        headers: {
          "Idempotency-Key": winningAmendment.key,
        },
        body: amendmentBody,
      },
    ));
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, amended.body);

    const audit = await prisma.giveawayAuditEvent.findFirst({
      where: { contestId: stored.id, action: "AMEND_STANDARD_RULES" },
    });
    assert.ok(audit);
    assert.equal(audit.requestBody.reason, AMENDMENT_REASON);
    assert.deepEqual(audit.requestBody.oldRules, {
      version: predecessor.version,
      hash: predecessor.hash,
      sections: predecessor.sections,
    });
    assert.equal(audit.requestBody.newRules.version, amended.body.contest.rules.version);
    assert.deepEqual(audit.responseBody.oldRules, audit.requestBody.oldRules);
    assert.deepEqual(audit.responseBody.newRules, audit.requestBody.newRules);

    const oldReplay = await read(await request(
      server.baseUrl,
      "POST",
      `/giveaways/${stored.slug}/entries`,
      {
        token: oldEntrant.token,
        headers: GLOBAL_FEATURES,
        body: { rulesVersion: predecessor.version, rulesAccepted: true },
      },
    ));
    assert.equal(oldReplay.status, 200);
    assert.equal(oldReplay.body.entry.rulesVersion, predecessor.version);

    const newEntrant = await createTestUser({ displayName: "NewEntrant" });
    const frozenAttempt = await read(await request(
      server.baseUrl,
      "POST",
      `/giveaways/${stored.slug}/entries`,
      {
        token: newEntrant.token,
        headers: GLOBAL_FEATURES,
        body: { rulesVersion: predecessor.version, rulesAccepted: true },
      },
    ));
    assert.equal(frozenAttempt.status, 409);
    assert.equal(frozenAttempt.body.code, "RULES_CHANGED");
    assert.equal(frozenAttempt.body.currentRulesVersion, amended.body.contest.rules.version);
    const newEntry = await read(await request(
      server.baseUrl,
      "POST",
      `/giveaways/${stored.slug}/entries`,
      {
        token: newEntrant.token,
        headers: GLOBAL_FEATURES,
        body: {
          rulesVersion: amended.body.contest.rules.version,
          rulesAccepted: true,
        },
      },
    ));
    assert.equal(newEntry.status, 201, JSON.stringify(newEntry.body));

    const oldRow = await prisma.giveawayEntrant.findUnique({
      where: { contestId_userId: { contestId: stored.id, userId: oldEntrant.user.id } },
    });
    const referee = await createTestUser({ displayName: "BoundaryRef" });
    await prisma.referral.create({
      data: {
        referrerId: oldEntrant.user.id,
        refereeId: referee.user.id,
        refereeSubHash: `amendment-boundary:${crypto.randomUUID()}`,
        status: "REWARDED",
        qualifiedAt: oldRow.rulesAcceptedAt,
      },
    });
    const dashboard = await read(await request(
      server.baseUrl,
      "GET",
      "/giveaways/current/me",
      { token: oldEntrant.token, headers: GLOBAL_FEATURES },
    ));
    assert.equal(dashboard.status, 200);
    assert.equal(dashboard.body.standing.verifiedCount, 1);
    const unchangedOldRow = await prisma.giveawayEntrant.findUnique({
      where: { id: oldRow.id },
    });
    assert.equal(unchangedOldRow.acceptedRulesVersion, predecessor.version);
    assert.equal(unchangedOldRow.acceptedRulesHash, predecessor.hash);
  });

  it("returns the unchanged public-profile-v1 contract for the caller's own ID", async () => {
    const self = await createTestUser({ displayName: "Self Profile Runner" });
    await prisma.step.createMany({
      data: [
        { userId: self.user.id, date: new Date("2026-08-20"), steps: 2000 },
        { userId: self.user.id, date: new Date("2026-08-21"), steps: 6000 },
      ],
    });
    for (const placement of [1, 2, 3]) {
      const race = await prisma.race.create({
        data: { name: `Self podium ${placement}`, status: "COMPLETED", targetSteps: 10000 },
      });
      await prisma.raceParticipant.create({
        data: { raceId: race.id, userId: self.user.id, status: "ACCEPTED", placement },
      });
    }
    const response = await read(await request(
      server.baseUrl,
      "GET",
      `/friends/${self.user.id}/profile`,
      { token: self.token, headers: { "X-Client-Features": "characters" } },
    ));
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      contract: "public-profile-v1",
      user: {
        id: self.user.id,
        displayName: "Self Profile Runner",
        profilePhotoUrl: null,
        equippedAnimal: null,
        equippedAccessories: [],
      },
      stats: {
        racePodiums: { first: 1, second: 1, third: 1 },
        avgStepsPerDay: 4000,
      },
    });
  });

  it("rejects a Decoy landing on a full Hitchhike target without consuming defenses or items", async () => {
    const attacker = await createTestUser({ displayName: "Anjali" });
    const decoyOwner = await createTestUser({ displayName: "Nathan" });
    const landing = await createTestUser({ displayName: "Shefali" });
    const existingCaster = await createTestUser({ displayName: "Existing Hitchhiker" });
    const raceId = await createActiveTeamRace({
      creator: attacker,
      teamA: [attacker, landing],
      teamB: [decoyOwner, existingCaster],
    });

    const existing = await giveHeld(raceId, existingCaster.user.id, "HITCHHIKE");
    assert.equal((await use(existingCaster, raceId, existing.id, landing.user.id)).status, 200);
    const decoy = await activate(decoyOwner, raceId, "DECOY");

    const legacy = await giveHeld(raceId, attacker.user.id, "HITCHHIKE");
    const legacyRejected = await read(await use(
      attacker,
      raceId,
      legacy.id,
      decoyOwner.user.id,
    ));
    assert.equal(legacyRejected.status, 409);
    assert.deepEqual(legacyRejected.body, {
      error: "Someone is already hitching a ride on that racer",
      code: "HITCHHIKE_TARGET_FULL",
    });
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: legacy.id } })).status,
      "HELD",
    );
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: decoy.id } })).status,
      "ACTIVE",
    );

    await prisma.userPowerupItem.create({
      data: { userId: attacker.user.id, powerupType: "HITCHHIKE", quantity: 1 },
    });
    const redeemed = await read(await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/redeem`,
      {
        token: attacker.token,
        headers: POWERUPS5,
        body: { powerupType: "HITCHHIKE" },
      },
    ));
    assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
    const redeemedId = redeemed.body.result.powerup.id;
    const coinsBefore = (await prisma.user.findUnique({ where: { id: attacker.user.id } })).coins;
    const eventCountBefore = await prisma.racePowerupEvent.count({ where: { raceId } });
    const effectCountBefore = await prisma.raceActiveEffect.count({ where: { raceId } });
    const rejected = await read(await use(
      attacker,
      raceId,
      redeemedId,
      decoyOwner.user.id,
    ));
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.code, "HITCHHIKE_TARGET_FULL");
    assert.equal(
      (await prisma.racePowerup.findUnique({ where: { id: redeemedId } })).status,
      "DISCARDED",
    );
    assert.equal(
      (await prisma.userPowerupItem.findUnique({
        where: {
          userId_powerupType: {
            userId: attacker.user.id,
            powerupType: "HITCHHIKE",
          },
        },
      })).quantity,
      1,
    );
    assert.equal(
      (await prisma.raceActiveEffect.findUnique({ where: { id: decoy.id } })).status,
      "ACTIVE",
    );
    assert.equal(await prisma.racePowerupEvent.count({ where: { raceId } }), eventCountBefore);
    assert.equal(await prisma.raceActiveEffect.count({ where: { raceId } }), effectCountBefore);
    assert.equal(
      (await prisma.user.findUnique({ where: { id: attacker.user.id } })).coins,
      coinsBefore,
    );
  });

  it("serializes simultaneous direct and redirected landings onto one final target", async () => {
    const redirectedCaster = await createTestUser({ displayName: "Redirect Caster" });
    const decoyOwner = await createTestUser({ displayName: "Redirect Holder" });
    const landing = await createTestUser({ displayName: "Shared Landing" });
    const directCaster = await createTestUser({ displayName: "Direct Caster" });
    const raceId = await createActiveTeamRace({
      creator: redirectedCaster,
      teamA: [redirectedCaster, landing],
      teamB: [decoyOwner, directCaster],
    });
    await activate(decoyOwner, raceId, "DECOY");
    const redirected = await giveHeld(raceId, redirectedCaster.user.id, "HITCHHIKE");
    const direct = await giveHeld(raceId, directCaster.user.id, "HITCHHIKE");

    const responses = await Promise.all([
      use(redirectedCaster, raceId, redirected.id, decoyOwner.user.id),
      use(directCaster, raceId, direct.id, landing.user.id),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    assert.equal(await prisma.raceActiveEffect.count({
      where: {
        raceId,
        type: "HITCHHIKE",
        status: "ACTIVE",
        targetUserId: landing.user.id,
        startsAt: { lte: CHECK_TIME },
        expiresAt: { gt: CHECK_TIME },
      },
    }), 1);
  });

  it("persists ordered redirect and redirected-Socks terminal rows in Activity and Timeline", async () => {
    const attacker = await createTestUser({ displayName: "Anjali" });
    const decoyOwner = await createTestUser({ displayName: "Nathan" });
    const landing = await createTestUser({ displayName: "Shefali" });
    const raceId = await createActiveRace([attacker, decoyOwner, landing]);
    await activate(decoyOwner, raceId, "DECOY");
    await activate(landing, raceId, "COMPRESSION_SOCKS");
    const hitchhike = await giveHeld(raceId, attacker.user.id, "HITCHHIKE");

    // Warm the public SYSTEM projection before the event-model write. This
    // suite intentionally has REDIS_URL unset, so the same call also proves
    // the Postgres fallback remains complete.
    const beforeUse = await systemMessages(attacker, raceId);
    assert.equal(beforeUse.status, 200);
    assert.equal(beforeUse.body.messages.some(
      (message) => message.eventType === "POWERUP_REDIRECTED",
    ), false);

    const used = await read(await use(attacker, raceId, hitchhike.id, decoyOwner.user.id));
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(used.body.result.blocked, true);
    assert.equal(used.body.result.redirected, true);

    const rows = await prisma.racePowerupEvent.findMany({
      where: { raceId, eventType: { in: ["POWERUP_REDIRECTED", "POWERUP_BLOCKED"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => ({
      eventType: row.eventType,
      powerupType: row.powerupType,
      actorUserId: row.actorUserId,
      targetUserId: row.targetUserId,
      description: row.description,
    })), [
      {
        eventType: "POWERUP_REDIRECTED",
        powerupType: "HITCHHIKE",
        actorUserId: decoyOwner.user.id,
        targetUserId: landing.user.id,
        description: "Nathan's Decoy redirected Anjali's Hitchhike to Shefali.",
      },
      {
        eventType: "POWERUP_BLOCKED",
        powerupType: "HITCHHIKE",
        actorUserId: landing.user.id,
        targetUserId: attacker.user.id,
        description: "Shefali's Compression Socks blocked the redirected Hitchhike.",
      },
    ]);
    assert.deepEqual(rows[0].metadata, {
      attackerUserId: attacker.user.id,
      decoyOwnerUserId: decoyOwner.user.id,
      redirectedUserId: landing.user.id,
    });
    assert.equal(rows[1].createdAt.getTime(), rows[0].createdAt.getTime() + 1);

    const activity = await systemMessages(attacker, raceId);
    assert.equal(activity.status, 200);
    assert.deepEqual(
      activity.body.messages
        .filter((message) => ["POWERUP_REDIRECTED", "POWERUP_BLOCKED"].includes(message.eventType))
        .map((message) => message.body),
      [rows[1].description, rows[0].description],
    );
    const timeline = await read(await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?view=timeline-v1&limit=30`,
      { token: attacker.token, headers: POWERUPS5 },
    ));
    assert.equal(timeline.status, 200);
    assert.equal(timeline.body.timelineVersion, 1);
    assert.deepEqual(
      timeline.body.messages
        .filter((message) => ["POWERUP_REDIRECTED", "POWERUP_BLOCKED"].includes(message.eventType))
        .map((message) => message.body),
      [rows[1].description, rows[0].description],
    );

    const firstPage = await systemMessages(attacker, raceId, "?limit=1");
    assert.equal(firstPage.body.messages[0].body, rows[1].description);
    const decoded = JSON.parse(
      Buffer.from(firstPage.body.nextCursor, "base64url").toString("utf8"),
    );
    assert.deepEqual(decoded, {
      v: 1,
      at: rows[1].createdAt.toISOString(),
      kind: "SYSTEM",
      id: rows[1].id,
    });
    const secondPage = await systemMessages(
      attacker,
      raceId,
      `?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`,
    );
    assert.equal(secondPage.body.messages[0].body, rows[0].description);
    const legacyPage = await systemMessages(
      attacker,
      raceId,
      `?limit=1&cursor=${encodeURIComponent(rows[1].createdAt.toISOString())}`,
    );
    assert.equal(legacyPage.body.messages[0].body, rows[0].description);

    const timelineFirst = await read(await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?view=timeline-v1&kind=SYSTEM&limit=1`,
      { token: attacker.token, headers: POWERUPS5 },
    ));
    assert.equal(timelineFirst.status, 200);
    assert.equal(timelineFirst.body.messages[0].body, rows[1].description);
    const timelineCursor = JSON.parse(
      Buffer.from(timelineFirst.body.nextCursor, "base64url").toString("utf8"),
    );
    assert.deepEqual(timelineCursor, {
      v: 1,
      at: rows[1].createdAt.toISOString(),
      kind: "SYSTEM",
      id: rows[1].id,
    });
    const timelineSecond = await read(await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/messages?view=timeline-v1&kind=SYSTEM&limit=1&cursor=${encodeURIComponent(timelineFirst.body.nextCursor)}`,
      { token: attacker.token, headers: POWERUPS5 },
    ));
    assert.equal(timelineSecond.status, 200);
    assert.equal(timelineSecond.body.messages[0].body, rows[0].description);
  });

  it("persists redirect then applied-use for an open landing and no false redirect on a two-player fizzle", async () => {
    const attacker = await createTestUser({ displayName: "Open Anjali" });
    const decoyOwner = await createTestUser({ displayName: "Open Nathan" });
    const landing = await createTestUser({ displayName: "Open Shefali" });
    const raceId = await createActiveRace([attacker, decoyOwner, landing]);
    await activate(decoyOwner, raceId, "DECOY");
    const hitchhike = await giveHeld(raceId, attacker.user.id, "HITCHHIKE");
    const applied = await read(await use(
      attacker,
      raceId,
      hitchhike.id,
      decoyOwner.user.id,
    ));
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body.result.redirected, true);
    assert.equal(applied.body.result.blocked, false);
    const appliedRows = await prisma.racePowerupEvent.findMany({
      where: {
        raceId,
        eventType: { in: ["POWERUP_REDIRECTED", "POWERUP_USED"] },
        powerupType: "HITCHHIKE",
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    assert.deepEqual(
      appliedRows.map((row) => row.eventType),
      ["POWERUP_REDIRECTED", "POWERUP_USED"],
    );
    assert.equal(
      appliedRows[1].createdAt.getTime(),
      appliedRows[0].createdAt.getTime() + 1,
    );

    const fizzleAttacker = await createTestUser({ displayName: "Fizzle Anjali" });
    const fizzleOwner = await createTestUser({ displayName: "Fizzle Nathan" });
    const fizzleRaceId = await createActiveRace([fizzleAttacker, fizzleOwner]);
    await activate(fizzleOwner, fizzleRaceId, "DECOY");
    const fizzleHitchhike = await giveHeld(
      fizzleRaceId,
      fizzleAttacker.user.id,
      "HITCHHIKE",
    );
    const fizzled = await read(await use(
      fizzleAttacker,
      fizzleRaceId,
      fizzleHitchhike.id,
      fizzleOwner.user.id,
    ));
    assert.equal(fizzled.status, 200, JSON.stringify(fizzled.body));
    assert.equal(fizzled.body.result.blocked, true);
    assert.equal(fizzled.body.result.blockedBy, "DECOY");
    const fizzleRows = await prisma.racePowerupEvent.findMany({
      where: { raceId: fizzleRaceId, powerupType: "HITCHHIKE" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    assert.deepEqual(
      fizzleRows.map((row) => row.eventType),
      ["POWERUP_BLOCKED"],
    );
  });

  it("redacts a stealthed attacker named only by redirect metadata for other viewers", async () => {
    const attacker = await createTestUser({ displayName: "Hidden Anjali" });
    const decoyOwner = await createTestUser({ displayName: "Nathan Visible" });
    const landing = await createTestUser({ displayName: "Shefali Visible" });
    const raceId = await createActiveRace([attacker, decoyOwner, landing]);
    await activate(attacker, raceId, "STEALTH_MODE");
    await activate(decoyOwner, raceId, "DECOY");
    const hitchhike = await giveHeld(raceId, attacker.user.id, "HITCHHIKE");
    assert.equal((await use(attacker, raceId, hitchhike.id, decoyOwner.user.id)).status, 200);

    const event = await prisma.racePowerupEvent.findFirst({
      where: { raceId, eventType: "POWERUP_REDIRECTED" },
    });
    assert.ok(event);
    const otherView = await systemMessages(decoyOwner, raceId);
    const redirectForOther = otherView.body.messages.find(
      (message) => message.eventType === "POWERUP_REDIRECTED",
    );
    assert.equal(
      redirectForOther.body,
      "Nathan Visible's Decoy redirected ???'s Hitchhike to Shefali Visible.",
    );
    const selfView = await systemMessages(attacker, raceId);
    const redirectForSelf = selfView.body.messages.find(
      (message) => message.eventType === "POWERUP_REDIRECTED",
    );
    assert.match(redirectForSelf.body, /Hidden Anjali/);

    const legacyFeed = await read(await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/feed`,
      { token: decoyOwner.token, headers: POWERUPS5 },
    ));
    const feedRedirect = legacyFeed.body.events.find(
      (row) => row.eventType === "POWERUP_REDIRECTED",
    );
    assert.equal(
      feedRedirect.description,
      "Nathan Visible's Decoy redirected ???'s Hitchhike to Shefali Visible.",
    );
  });

  it("enforces exact half-open Hitchhike liveness at injected CHECK_TIME over real HTTP casts", async () => {
    const casters = await Promise.all(
      ["Expiry", "Future Expiry", "Exact Start", "Future Start"].map(
        (label) => createTestUser({ displayName: `${label} Caster` }),
      ),
    );
    const targets = await Promise.all(
      ["Expiry", "Future Expiry", "Exact Start", "Future Start"].map(
        (label) => createTestUser({ displayName: `${label} Target` }),
      ),
    );
    const blocker = await createTestUser({ displayName: "Boundary Blocker" });
    const raceId = await createActiveRace([...casters, ...targets, blocker]);

    async function seedAndCast({ caster, target, startsAt, expiresAt }) {
      const blockerItem = await giveHeld(raceId, blocker.user.id, "HITCHHIKE");
      const targetParticipant = await participant(raceId, target.user.id);
      const existing = await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: target.user.id,
          sourceUserId: blocker.user.id,
          powerupId: blockerItem.id,
          type: "HITCHHIKE",
          status: "ACTIVE",
          startsAt,
          expiresAt,
        },
      });
      assert.equal(existing.startsAt.toISOString(), startsAt.toISOString());
      assert.equal(existing.expiresAt.toISOString(), expiresAt.toISOString());
      const castItem = await giveHeld(raceId, caster.user.id, "HITCHHIKE");
      return read(await use(caster, raceId, castItem.id, target.user.id));
    }

    const atExpiry = await seedAndCast({
      caster: casters[0],
      target: targets[0],
      startsAt: new Date(CHECK_TIME.getTime() - 1),
      expiresAt: CHECK_TIME,
    });
    assert.equal(atExpiry.status, 200, JSON.stringify(atExpiry.body));

    const oneMillisecondAfterExpiry = await seedAndCast({
      caster: casters[1],
      target: targets[1],
      startsAt: new Date(CHECK_TIME.getTime() - 1),
      expiresAt: new Date(CHECK_TIME.getTime() + 1),
    });
    assert.equal(oneMillisecondAfterExpiry.status, 409);
    assert.equal(oneMillisecondAfterExpiry.body.code, "HITCHHIKE_TARGET_FULL");

    const atStart = await seedAndCast({
      caster: casters[2],
      target: targets[2],
      startsAt: CHECK_TIME,
      expiresAt: new Date(CHECK_TIME.getTime() + 1),
    });
    assert.equal(atStart.status, 409);
    assert.equal(atStart.body.code, "HITCHHIKE_TARGET_FULL");

    const oneMillisecondBeforeStart = await seedAndCast({
      caster: casters[3],
      target: targets[3],
      startsAt: new Date(CHECK_TIME.getTime() + 1),
      expiresAt: new Date(CHECK_TIME.getTime() + 2),
    });
    assert.equal(oneMillisecondBeforeStart.status, 200, JSON.stringify(oneMillisecondBeforeStart.body));
  });
});
