const assert = require("node:assert/strict");
const { before, beforeEach, describe, it } = require("node:test");

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");
const { appSettings } = require("../../src/shared/config/appSettings");
const { balanceConfig } = require("../../src/modules/economy/balanceConfig");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");
const {
  buildDomainEventProjectionJob,
} = require("../../src/modules/domainEvents");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";
const POWERUPS = {
  "X-Client-Features":
    "characters,powerups2,powerups3,powerups4,powerups5,hitchhike_effective_steps,inbox_v1",
};
const quietLogger = { log() {}, warn() {}, error() {} };
const HOUR_MS = 60 * 60 * 1000;
let server;
let sequence = 0;

async function makeUser(displayName, overrides = {}) {
  const created = await createTestUser({
    appleId: `feature-batch-2026-08-28-${++sequence}`,
    email: `feature-batch-2026-08-28-${sequence}@example.com`,
    displayName,
    ...overrides,
  });
  return { id: created.user.id, token: created.token, user: created.user };
}

async function makeFriends(requester, addressee) {
  const sent = await request(server.baseUrl, "POST", "/friends/request", {
    token: requester.token,
    body: { addresseeId: addressee.id },
  });
  assert.equal(sent.status, 201);
  const friendshipId = (await sent.json()).friendship.id;
  const accepted = await request(
    server.baseUrl,
    "PUT",
    `/friends/request/${friendshipId}`,
    { token: addressee.token, body: { accept: true } },
  );
  assert.equal(accepted.status, 200);
}

async function createRace(owner, overrides = {}) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token: owner.token,
    body: {
      name: `August 28 race ${++sequence}`,
      targetSteps: 500_000,
      maxDurationDays: 7,
      maxParticipants: 30,
      isPublic: true,
      ...overrides,
    },
  });
  return response;
}

async function createActivePowerupRace(owner, others) {
  for (const other of others) await makeFriends(owner, other);
  const created = await createRace(owner, {
    powerupsEnabled: true,
    powerupStepInterval: 5_000,
  });
  assert.equal(created.status, 201);
  const raceId = (await created.json()).race.id;
  const invited = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/invite`,
    {
      token: owner.token,
      body: { inviteeIds: others.map((entry) => entry.id) },
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
  const started = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/start`,
    { token: owner.token },
  );
  assert.equal(started.status, 200);
  const startsAt = new Date(Date.now() - 2 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt: startsAt,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startsAt },
  });
  return raceId;
}

async function participant(raceId, userId) {
  return prisma.raceParticipant.findUnique({
    where: { raceId_userId: { raceId, userId } },
  });
}

async function giveHeld(raceId, userId, type, earnedAtSteps = 1) {
  const row = await participant(raceId, userId);
  return prisma.racePowerup.create({
    data: {
      raceId,
      participantId: row.id,
      userId,
      type,
      rarity: "UNCOMMON",
      status: "HELD",
      earnedAtSteps,
    },
  });
}

async function giveActiveDecoy(raceId, ownerUserId, sourcePowerupUserId) {
  const owner = await participant(raceId, ownerUserId);
  const source = await participant(raceId, sourcePowerupUserId);
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId,
      participantId: source.id,
      userId: sourcePowerupUserId,
      type: "DECOY",
      rarity: "UNCOMMON",
      status: "USED",
      earnedAtSteps: 9_999,
    },
  });
  return prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: owner.id,
      targetUserId: ownerUserId,
      sourceUserId: sourcePowerupUserId,
      powerupId: powerup.id,
      type: "DECOY",
      status: "ACTIVE",
      startsAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * HOUR_MS),
      metadata: {},
    },
  });
}

async function pinMysteryPotionPool(outcome) {
  const config = defaultConfig();
  config.mysteryPotion = { pool: [{ outcome, weight: 1 }] };
  await prisma.balanceConfig.updateMany({
    where: { active: true },
    data: { active: false },
  });
  const maxVersion = await prisma.balanceConfig.aggregate({
    _max: { version: true },
  });
  await prisma.balanceConfig.create({
    data: {
      version: (maxVersion._max.version || 0) + 1,
      config,
      active: true,
      note: "feature batch deterministic Mystery Potion",
    },
  });
  balanceConfig.bustCache();
  await balanceConfig.getSnapshot();
}

function participantSteps(payload, userId) {
  return payload.progress.participants.find((entry) => entry.userId === userId)
    ?.totalSteps;
}

function dateOnlyFor(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
}

async function setDailySteps(userId, date, steps) {
  return prisma.step.upsert({
    where: { userId_date: { userId, date } },
    update: { steps },
    create: { userId, date, steps },
  });
}

async function makeV3Hitchhike(raceId, caster, target, startsAt, expiresAt) {
  const held = await giveHeld(raceId, caster.id, "HITCHHIKE", 15_100 + sequence);
  const used = await request(
    server.baseUrl,
    "POST",
    `/races/${raceId}/powerups/${held.id}/use`,
    {
      token: caster.token,
      headers: POWERUPS,
      body: { targetUserId: target.id },
    },
  );
  assert.equal(used.status, 200);
  const effect = await prisma.raceActiveEffect.findFirstOrThrow({
    where: { powerupId: held.id, type: "HITCHHIKE" },
  });
  return prisma.raceActiveEffect.update({
    where: { id: effect.id },
    data: {
      startsAt,
      expiresAt,
      metadata: { copyRatio: 1, scoringVersion: 3 },
    },
  });
}

async function readProgress(raceId, viewer) {
  const response = await request(
    server.baseUrl,
    "GET",
    `/races/${raceId}/progress`,
    { token: viewer.token, headers: POWERUPS },
  );
  assert.equal(response.status, 200);
  return response.json();
}

describe("feature batch 2026-08-28 backend contracts", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.globalStepEvent.deleteMany();
    await prisma.appSetting.deleteMany({
      where: { key: "activeCompetitionLimit" },
    });
    sequence = 0;
    appSettings.bustCache();
    await appSettings.setFlag("redisStandingsEnabled", true);
    await appSettings.setFlag("apiFriendsSummaryV1Enabled", true);
    await appSettings.setFlag("apiInboxV1Enabled", true);
  });

  it("locks the dedicated admin active-competition-limit contract and validation", async () => {
    const admin = await makeUser("Admin", { email: ADMIN_EMAIL });

    const initial = await request(
      server.baseUrl,
      "GET",
      "/admin/settings/active-competition-limit",
      { token: admin.token },
    );
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      activeCompetitionLimit: 20,
      minimum: 1,
      maximum: 20,
      updatedAt: null,
    });

    for (const invalid of [null, true, "10", 1.5, 0, 21, [], {}]) {
      const response = await request(
        server.baseUrl,
        "PATCH",
        "/admin/settings/active-competition-limit",
        { token: admin.token, body: { activeCompetitionLimit: invalid } },
      );
      assert.equal(response.status, 400, JSON.stringify(invalid));
      assert.deepEqual(await response.json(), {
        error: "activeCompetitionLimit must be an integer from 1 to 20",
        code: "INVALID_ACTIVE_COMPETITION_LIMIT",
      });
    }

    const saved = await request(
      server.baseUrl,
      "PATCH",
      "/admin/settings/active-competition-limit",
      { token: admin.token, body: { activeCompetitionLimit: 7 } },
    );
    assert.equal(saved.status, 200);
    const savedBody = await saved.json();
    assert.equal(savedBody.activeCompetitionLimit, 7);
    assert.equal(savedBody.minimum, 1);
    assert.equal(savedBody.maximum, 20);
    assert.match(savedBody.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("enforces one configured limit over free race and tournament memberships", async () => {
    const user = await makeUser("Limit Owner");
    const admin = await makeUser("Admin", { email: ADMIN_EMAIL });
    const changed = await request(
      server.baseUrl,
      "PATCH",
      "/admin/settings/active-competition-limit",
      { token: admin.token, body: { activeCompetitionLimit: 3 } },
    );
    assert.equal(changed.status, 200);

    for (let index = 0; index < 2; index += 1) {
      const created = await createRace(user, {
        name: `Free active ${index}`,
        buyInAmount: 0,
      });
      assert.equal(created.status, 201);
    }
    const tournament = await prisma.tournament.create({
      data: {
        creatorId: user.id,
        name: "Counted free tournament",
        status: "PENDING",
        bracketSize: 4,
        matchupDurationDays: 1,
        totalRounds: 2,
        fundedPrize: false,
        isPublic: true,
      },
    });
    await prisma.tournamentParticipant.create({
      data: {
        tournamentId: tournament.id,
        userId: user.id,
        status: "ACCEPTED",
      },
    });

    const rejected = await createRace(user, {
      name: "One too many",
      buyInAmount: 0,
    });
    assert.equal(rejected.status, 409);
    assert.deepEqual(await rejected.json(), {
      error: "You can have up to 3 active competitions at a time.",
      code: "ACTIVE_COMPETITION_LIMIT",
      limit: 3,
      current: 3,
    });

    const tournamentRejected = await request(
      server.baseUrl,
      "POST",
      "/tournaments",
      {
        token: user.token,
        headers: { "X-Client-Features": "tournaments" },
        body: {
          name: "One bracket too many",
          bracketSize: 4,
          matchupDurationDays: 1,
          isPublic: true,
        },
      },
    );
    assert.equal(tournamentRejected.status, 409);
    assert.deepEqual(await tournamentRejected.json(), {
      error: "You can have up to 3 active competitions at a time.",
      code: "ACTIVE_COMPETITION_LIMIT",
      limit: 3,
      current: 3,
    });
  });

  it("returns first and last names additively only on pending friend users", async () => {
    const recipient = await makeUser("recipient");
    const requester = await makeUser("requester", {
      firstName: "Anjali",
      lastName: "Patel",
    });
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token,
      body: { addresseeId: recipient.id },
    });
    assert.equal(sent.status, 201);

    const response = await request(
      server.baseUrl,
      "GET",
      "/friends?view=summary-v1",
      { token: recipient.token },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.pending.incoming[0].user, {
      id: requester.id,
      displayName: "requester",
      profilePhotoUrl: null,
      firstName: "Anjali",
      lastName: "Patel",
    });
  });

  it("returns a truthful first-read mystery-box countdown without mutating the gate", async () => {
    const originalRedisUrl = process.env.REDIS_URL;
    try {
      for (const mode of ["enabled", "disabled", "unset"]) {
        await appSettings.setFlag("redisStandingsEnabled", mode === "enabled");
        if (mode === "unset") delete process.env.REDIS_URL;
        else if (originalRedisUrl == null) delete process.env.REDIS_URL;
        else process.env.REDIS_URL = originalRedisUrl;

        const owner = await makeUser(`Box Owner ${mode}`);
        const teammate = await makeUser(`Box Teammate ${mode}`);
        const raceId = await createActivePowerupRace(owner, [teammate]);
        const row = await participant(raceId, owner.id);
        await prisma.raceParticipant.update({
          where: { id: row.id },
          data: { totalSteps: 1_250, rawSteps: 1_250, nextBoxAtSteps: 0 },
        });

        const response = await request(
          server.baseUrl,
          "GET",
          `/races/${raceId}/progress`,
          { token: owner.token, headers: POWERUPS },
        );
        assert.equal(response.status, 200, mode);
        const body = await response.json();
        assert.equal(body.progress.powerupData.stepsUntilNextPowerup, 2_000, mode);
        assert.equal(
          (await participant(raceId, owner.id)).nextBoxAtSteps,
          0,
          `${mode}: the hot read derives the boundary but never writes race_participants`,
        );
        assert.equal(
          await prisma.raceResolutionJobV2.count({ where: { raceId } }),
          1,
          `${mode}: the C0 worker is queued to persist repair`,
        );

        const worker = buildRaceResolutionWorkerV2({
          bootAt: 0,
          logger: quietLogger,
        });
        assert.ok(await worker.processRace({ raceId }), mode);
        const repaired = await participant(raceId, owner.id);
        assert.equal(repaired.nextBoxAtSteps, 2_000, mode);
        const boxesAfterFirstRepair = await prisma.racePowerup.count({
          where: { participantId: row.id },
        });
        assert.ok(await worker.processRace({ raceId }), `${mode}: idempotent replay`);
        assert.equal(
          await prisma.racePowerup.count({ where: { participantId: row.id } }),
          boxesAfterFirstRepair,
          `${mode}: repair replay cannot mint a duplicate box`,
        );
      }
    } finally {
      if (originalRedisUrl == null) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("durably notifies a Decoy owner exactly once when a two-player attack is blocked", async () => {
    const attacker = await makeUser("Attacker");
    const owner = await makeUser("Decoy Owner");
    const raceId = await createActivePowerupRace(attacker, [owner]);
    const decoy = await giveActiveDecoy(raceId, owner.id, owner.id);
    const attack = await giveHeld(raceId, attacker.id, "LEG_CRAMP", 12_345);

    const used = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${attack.id}/use`,
      {
        token: attacker.token,
        headers: POWERUPS,
        body: { targetUserId: owner.id },
      },
    );
    assert.equal(used.status, 200);
    assert.equal((await used.json()).result.outcome, "BLOCKED");

    const event = await prisma.domainEventOutbox.findUnique({
      where: { eventKey: `DECOY_CONSUMED_V1:${decoy.id}` },
      include: { audience: true },
    });
    assert.ok(event);
    assert.equal(event.eventType, "DECOY_CONSUMED_V1");
    assert.deepEqual(event.audience.map((entry) => entry.recipientId), [owner.id]);
    assert.equal(event.payload.attackerUserId, attacker.id);
    assert.equal(event.payload.outcome, "BLOCKED");

    const project = buildDomainEventProjectionJob({ logger: quietLogger });
    await project();
    await project();
    const alerts = await prisma.inboxAlert.findMany({
      where: { userId: owner.id, type: "POWERUP_USED" },
      include: { outbox: true },
    });
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].title, "Your Decoy was triggered!");
    assert.equal(
      alerts[0].outbox[0].payload.payload.subtype,
      "DECOY_CONSUMED",
    );
    assert.deepEqual(alerts[0].outbox[0].payload.payload.params, { raceId });
    assert.deepEqual(alerts[0].destination, { route: "raceDetail", raceId });
    assert.equal(alerts[0].body.includes("Attacker"), false);
    assert.equal(alerts[0].outbox.length, 1);

    const inbox = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: owner.token,
      headers: POWERUPS,
    });
    assert.equal(inbox.status, 200);
    const publicAlert = (await inbox.json()).alerts.find(
      (alert) => alert.id === alerts[0].id,
    );
    assert.equal(publicAlert.type, "POWERUP_USED");
    assert.equal(publicAlert.subtype, "DECOY_CONSUMED");
    assert.deepEqual(publicAlert.destination, { route: "raceDetail", raceId });
  });

  it("records the consumed owner's alert when a targeted attack is redirected", async () => {
    const attacker = await makeUser("Redirect Attacker");
    const owner = await makeUser("Redirect Owner");
    const destination = await makeUser("Redirect Destination");
    const raceId = await createActivePowerupRace(attacker, [owner, destination]);
    const decoy = await giveActiveDecoy(raceId, owner.id, owner.id);
    const attack = await giveHeld(raceId, attacker.id, "LEG_CRAMP", 12_346);

    const used = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${attack.id}/use`,
      {
        token: attacker.token,
        headers: POWERUPS,
        body: { targetUserId: owner.id },
      },
    );
    assert.equal(used.status, 200);
    const result = (await used.json()).result;
    assert.equal(result.outcome, "REDIRECTED");
    assert.equal(result.redirectedToUserId, destination.id);

    const event = await prisma.domainEventOutbox.findUnique({
      where: { eventKey: `DECOY_CONSUMED_V1:${decoy.id}` },
    });
    assert.ok(event);
    assert.equal(event.payload.ownerUserId, owner.id);
    assert.equal(event.payload.attackerUserId, attacker.id);
    assert.equal(event.payload.attackPowerupType, "LEG_CRAMP");
    assert.equal(event.payload.outcome, "REDIRECTED");
  });

  it("records the rolled Mystery Potion attack type and exposes its Decoy Inbox subtype", async () => {
    const attacker = await makeUser("Potion Attacker");
    const owner = await makeUser("Potion Decoy Owner");
    const raceId = await createActivePowerupRace(attacker, [owner]);
    const decoy = await giveActiveDecoy(raceId, owner.id, owner.id);
    const potion = await giveHeld(raceId, attacker.id, "MYSTERY_POTION", 12_347);
    await pinMysteryPotionPool("LEG_CRAMP");

    const used = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${potion.id}/use`,
      { token: attacker.token, headers: POWERUPS, body: {} },
    );
    assert.equal(used.status, 200);
    const result = (await used.json()).result;
    assert.equal(result.rolled, "LEG_CRAMP");
    assert.equal(result.outcome, "BLOCKED");

    const event = await prisma.domainEventOutbox.findUniqueOrThrow({
      where: { eventKey: `DECOY_CONSUMED_V1:${decoy.id}` },
    });
    assert.equal(event.payload.attackPowerupType, "LEG_CRAMP");

    await buildDomainEventProjectionJob({ logger: quietLogger })();
    const inbox = await request(server.baseUrl, "GET", "/inbox/alerts", {
      token: owner.token,
      headers: POWERUPS,
    });
    assert.equal(inbox.status, 200);
    const alert = (await inbox.json()).alerts.find(
      (entry) => entry.type === "POWERUP_USED",
    );
    assert.equal(alert.subtype, "DECOY_CONSUMED");
  });

  it("rolls Decoy consumption back when its durable event cannot be appended", async () => {
    const attacker = await makeUser("Rollback Attacker");
    const owner = await makeUser("Rollback Owner");
    const raceId = await createActivePowerupRace(attacker, [owner]);
    const decoy = await giveActiveDecoy(raceId, owner.id, owner.id);
    const attack = await giveHeld(raceId, attacker.id, "LEG_CRAMP", 12_348);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_decoy_domain_event()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.event_type = 'DECOY_CONSUMED_V1' THEN
          RAISE EXCEPTION 'intentional Decoy domain-event failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_decoy_domain_event_trigger
      BEFORE INSERT ON domain_event_outbox
      FOR EACH ROW EXECUTE FUNCTION test_fail_decoy_domain_event();
    `);
    try {
      const used = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${attack.id}/use`,
        {
          token: attacker.token,
          headers: POWERUPS,
          body: { targetUserId: owner.id },
        },
      );
      assert.equal(used.status, 500);
      assert.equal(
        (await prisma.raceActiveEffect.findUniqueOrThrow({
          where: { id: decoy.id },
        })).status,
        "ACTIVE",
      );
      assert.equal(
        (await prisma.racePowerup.findUniqueOrThrow({
          where: { id: attack.id },
        })).status,
        "HELD",
      );
      assert.equal(
        await prisma.domainEventOutbox.count({
          where: { eventKey: `DECOY_CONSUMED_V1:${decoy.id}` },
        }),
        0,
      );
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_decoy_domain_event_trigger
          ON domain_event_outbox;
        DROP FUNCTION IF EXISTS test_fail_decoy_domain_event();
      `);
    }
  });

  it("reads a v3 Hitchhike current-hour capture as a full 1:1 copy", async () => {
    const caster = await makeUser("Nathan");
    const target = await makeUser("Sapna");
    const raceId = await createActivePowerupRace(caster, [target]);
    const hitchhike = await giveHeld(raceId, caster.id, "HITCHHIKE", 15_000);
    const cast = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/powerups/${hitchhike.id}/use`,
      {
        token: caster.token,
        headers: POWERUPS,
        body: { targetUserId: target.id },
      },
    );
    assert.equal(cast.status, 200);
    const effect = await prisma.raceActiveEffect.findFirstOrThrow({
      where: { raceId, type: "HITCHHIKE" },
    });
    assert.equal(effect.metadata.scoringVersion, 2);
    const startsAt = new Date(Date.now() - 56 * 60 * 1000);
    await prisma.raceActiveEffect.update({
      where: { id: effect.id },
      data: {
        startsAt,
        expiresAt: new Date(startsAt.getTime() + HOUR_MS),
        metadata: { copyRatio: 1, scoringVersion: 3 },
      },
    });
    await prisma.stepSample.create({
      data: {
        userId: target.id,
        periodStart: startsAt,
        periodEnd: new Date(),
        steps: 4_129,
        sourceName: "healthkit",
      },
    });

    const progress = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: caster.token, headers: POWERUPS },
    );
    assert.equal(progress.status, 200);
    const body = await progress.json();
    assert.equal(participantSteps(body, caster.id), 4_129);
    assert.equal(participantSteps(body, target.id), 4_129);

    const replay = await request(
      server.baseUrl,
      "GET",
      `/races/${raceId}/progress`,
      { token: caster.token, headers: POWERUPS },
    );
    assert.equal(replay.status, 200);
    assert.equal(participantSteps(await replay.json(), caster.id), 4_129);

    const captures = await prisma.$queryRawUnsafe(
      `SELECT effect_id AS "effectId", scoring_version AS "scoringVersion",
              raw_source_kind AS "rawSourceKind",
              raw_source_high_water AS "rawSourceHighWater",
              effective_contribution AS "effectiveContribution",
              capture_through AS "captureThrough"
         FROM hitchhike_attribution_captures
        WHERE effect_id = $1`,
      effect.id,
    );
    assert.equal(captures.length, 1);
    assert.equal(captures[0].scoringVersion, 3);
    assert.equal(captures[0].rawSourceKind, "EXACT_SAMPLES");
    assert.equal(captures[0].rawSourceHighWater, 4_129);
    assert.equal(captures[0].effectiveContribution, 4_129);
    assert.ok(captures[0].captureThrough instanceof Date);
  });

  it("derives coarse-only v3 increments from the target's canonical snapshot checkpoints", async () => {
    const cases = [
      { type: "RUNNERS_HIGH", expectedTarget: 1_800, expectedCopy: 800 },
      // The canonical sample-less target fallback intentionally has no Wrong
      // Turn snapshot term; Hitchhike must not manufacture a reversal either.
      { type: "WRONG_TURN", expectedTarget: 1_500, expectedCopy: 500 },
      { type: "LEG_CRAMP", expectedTarget: 1_200, expectedCopy: 200 },
    ];
    for (const testCase of cases) {
      await cleanDatabase();
      const caster = await makeUser(`${testCase.type} Caster`);
      const target = await makeUser(`${testCase.type} Target`);
      const raceId = await createActivePowerupRace(caster, [target]);
      const now = new Date();
      const day = dateOnlyFor(now, "UTC");
      await prisma.race.update({
        where: { id: raceId },
        data: {
          startedAt: day,
          endsAt: new Date(now.getTime() + 6 * HOUR_MS),
          timezone: "UTC",
        },
      });
      await prisma.raceParticipant.updateMany({
        where: { raceId },
        data: { joinedAt: day },
      });
      await setDailySteps(target.id, day, 1_000);
      const effect = await makeV3Hitchhike(
        raceId,
        caster,
        target,
        new Date(now.getTime() - 10 * 60 * 1000),
        new Date(now.getTime() + 50 * 60 * 1000),
      );

      await readProgress(raceId, caster);
      const targetParticipant = await participant(raceId, target.id);
      const sourcePowerup = await giveHeld(
        raceId,
        target.id,
        "PROTEIN_SHAKE",
        15_200 + sequence,
      );
      await prisma.raceActiveEffect.create({
        data: {
          raceId,
          targetParticipantId: targetParticipant.id,
          targetUserId: target.id,
          sourceUserId: target.id,
          powerupId: sourcePowerup.id,
          type: testCase.type,
          status: "ACTIVE",
          startsAt: new Date(now.getTime() - 5 * 60 * 1000),
          expiresAt: new Date(now.getTime() + 30 * 60 * 1000),
          metadata: testCase.type === "RUNNERS_HIGH"
              ? { stepsAtBuffStart: 1_200 }
            : testCase.type === "WRONG_TURN"
              ? { stepsAtStart: 1_200 }
              : { stepsAtFreezeStart: 1_200 },
        },
      });
      await setDailySteps(target.id, day, 1_500);

      const live = await readProgress(raceId, caster);
      assert.equal(
        participantSteps(live, target.id),
        testCase.expectedTarget,
        `${testCase.type} target canonical total`,
      );
      assert.equal(
        participantSteps(live, caster.id),
        testCase.expectedCopy,
        `${testCase.type} Hitchhike delta`,
      );
      const replay = await readProgress(raceId, caster);
      assert.equal(
        participantSteps(replay, caster.id),
        testCase.expectedCopy,
        `${testCase.type} replay`,
      );
      const capture = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
        where: { effectId: effect.id },
      });
      assert.equal(
        capture.rawSourceKind,
        "COARSE_DAILY_DELTA",
        testCase.type,
      );
      assert.equal(capture.rawSourceHighWater, 500, testCase.type);
      assert.equal(capture.effectiveContribution, testCase.expectedCopy, testCase.type);
    }
  });

  it("atomically rolls back coarse source ownership when credit persistence fails", async () => {
    const caster = await makeUser("Atomic Hitch Caster");
    const target = await makeUser("Atomic Hitch Target");
    const raceId = await createActivePowerupRace(caster, [target]);
    const now = new Date();
    const day = dateOnlyFor(now, "UTC");
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
    await setDailySteps(target.id, day, 1_000);
    const effect = await makeV3Hitchhike(
      raceId, caster, target,
      new Date(now.getTime() - 5 * 60 * 1000),
      new Date(now.getTime() + 55 * 60 * 1000),
    );
    await readProgress(raceId, caster);
    await setDailySteps(target.id, day, 1_500);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_fail_hitch_coarse_credit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.coarse_effective_contribution <> OLD.coarse_effective_contribution THEN
          RAISE EXCEPTION 'intentional Hitchhike coarse-credit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_fail_hitch_coarse_credit_trigger
      BEFORE UPDATE ON hitchhike_attribution_captures
      FOR EACH ROW EXECUTE FUNCTION test_fail_hitch_coarse_credit();
    `);
    try {
      const failed = await request(
        server.baseUrl,
        "GET",
        `/races/${raceId}/progress`,
        { token: caster.token, headers: POWERUPS },
      );
      assert.equal(failed.status, 500);
      const afterFailure = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
        where: { effectId: effect.id },
      });
      assert.equal(afterFailure.coarseRawAttributed, 0);
      assert.equal(afterFailure.coarseEffectiveContribution, 0);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_fail_hitch_coarse_credit_trigger
          ON hitchhike_attribution_captures;
        DROP FUNCTION IF EXISTS test_fail_hitch_coarse_credit();
      `);
    }

    const replay = await readProgress(raceId, caster);
    assert.equal(participantSteps(replay, caster.id), 500);
    const recovered = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
      where: { effectId: effect.id },
    });
    assert.equal(recovered.coarseRawAttributed, 500);
    assert.equal(recovered.coarseEffectiveContribution, 500);
  });

  it("serializes a coarse claim against a concurrent terminal freeze and replays the frozen value", async () => {
    const caster = await makeUser("Freeze Race Hitch Caster");
    const target = await makeUser("Freeze Race Hitch Target");
    const raceId = await createActivePowerupRace(caster, [target]);
    const now = new Date();
    const day = dateOnlyFor(now, "UTC");
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
    await setDailySteps(target.id, day, 1_000);
    const effect = await makeV3Hitchhike(
      raceId, caster, target,
      new Date(now.getTime() - 5 * 60 * 1000),
      new Date(now.getTime() + 55 * 60 * 1000),
    );
    await readProgress(raceId, caster);
    await setDailySteps(target.id, day, 1_500);

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_pause_hitch_coarse_claim()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.coarse_raw_attributed <> OLD.coarse_raw_attributed THEN
          PERFORM pg_sleep(0.5);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER test_pause_hitch_coarse_claim_trigger
      BEFORE UPDATE ON hitchhike_attribution_captures
      FOR EACH ROW EXECUTE FUNCTION test_pause_hitch_coarse_claim();
    `);
    try {
      const claimRequest = request(
        server.baseUrl,
        "GET",
        `/races/${raceId}/progress`,
        { token: caster.token, headers: POWERUPS },
      );
      let claimInFlight = false;
      for (let attempt = 0; attempt < 25; attempt += 1) {
        const rows = await prisma.$queryRawUnsafe(`
          SELECT 1
            FROM pg_stat_activity
           WHERE pid <> pg_backend_pid()
             AND state = 'active'
             AND query LIKE '%UPDATE hitchhike_attribution_captures%'
           LIMIT 1
        `);
        if (rows.length) {
          claimInFlight = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(claimInFlight, true);

      const finishedAt = new Date();
      await prisma.raceParticipant.update({
        where: { raceId_userId: { raceId, userId: target.id } },
        data: { finishedAt, finishTotalSteps: 1_500 },
      });
      const freezeRequest = request(
        server.baseUrl,
        "GET",
        `/races/${raceId}/progress`,
        { token: caster.token, headers: POWERUPS },
      );
      const [claimResponse, freezeResponse] = await Promise.all([
        claimRequest,
        freezeRequest,
      ]);
      assert.equal(claimResponse.status, 200);
      assert.equal(freezeResponse.status, 200);
    } finally {
      await prisma.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS test_pause_hitch_coarse_claim_trigger
          ON hitchhike_attribution_captures;
        DROP FUNCTION IF EXISTS test_pause_hitch_coarse_claim();
      `);
    }

    const frozen = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
      where: { effectId: effect.id },
    });
    assert.equal(frozen.coarseRawAttributed, 500);
    assert.equal(frozen.coarseEffectiveContribution, 500);
    assert.equal(frozen.effectiveContribution, 500);
    assert.ok(frozen.frozenAt);
    await setDailySteps(target.id, day, 2_000);
    assert.equal(
      participantSteps(await readProgress(raceId, caster), caster.id),
      500,
    );
  });

  it("gives each coarse source increment to only one sequential v3 Hitchhike and freezes clamps", async () => {
    const firstCaster = await makeUser("First Hitch Caster");
    const secondCaster = await makeUser("Second Hitch Caster");
    const target = await makeUser("Sequential Target");
    const raceId = await createActivePowerupRace(firstCaster, [secondCaster, target]);
    const now = new Date();
    const day = dateOnlyFor(now, "UTC");
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
    await setDailySteps(target.id, day, 1_000);

    const first = await makeV3Hitchhike(
      raceId, firstCaster, target,
      new Date(now.getTime() - 50 * 60 * 1000),
      new Date(now.getTime() + 10 * 60 * 1000),
    );
    await readProgress(raceId, firstCaster);
    await setDailySteps(target.id, day, 1_500);
    await readProgress(raceId, firstCaster);

    const handoffAt = new Date(Date.now() + 5);
    await prisma.raceActiveEffect.update({
      where: { id: first.id },
      data: { expiresAt: handoffAt },
    });
    const secondPowerup = await giveHeld(
      raceId, secondCaster.id, "HITCHHIKE", 15_300 + sequence,
    );
    const targetParticipant = await participant(raceId, target.id);
    const second = await prisma.raceActiveEffect.create({
      data: {
        raceId,
        targetParticipantId: targetParticipant.id,
        targetUserId: target.id,
        sourceUserId: secondCaster.id,
        powerupId: secondPowerup.id,
        type: "HITCHHIKE",
        status: "ACTIVE",
        startsAt: handoffAt,
        expiresAt: new Date(handoffAt.getTime() + HOUR_MS),
        metadata: { copyRatio: 1, scoringVersion: 3 },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await readProgress(raceId, secondCaster);
    await setDailySteps(target.id, day, 2_000);
    const live = await readProgress(raceId, secondCaster);
    assert.equal(participantSteps(live, firstCaster.id), 500);
    assert.equal(participantSteps(live, secondCaster.id), 500);

    const captures = await prisma.hitchhikeAttributionCapture.findMany({
      where: { effectId: { in: [first.id, second.id] } },
      orderBy: { castSampleBoundaryAt: "asc" },
    });
    assert.deepEqual(
      captures.map((capture) => capture.rawSourceHighWater),
      [500, 500],
    );
    assert.ok(captures[0].frozenAt);

    await setDailySteps(target.id, day, 2_500);
    const replay = await readProgress(raceId, secondCaster);
    assert.equal(participantSteps(replay, firstCaster.id), 500);
    assert.equal(participantSteps(replay, secondCaster.id), 1_000);
  });

  it("uses the canonical non-UTC race day on Home and matches race progress", async () => {
    const timeZone = "Pacific/Kiritimati";
    const caster = await makeUser("Home Hitch Caster");
    const target = await makeUser("Home Hitch Target");
    const raceId = await createActivePowerupRace(caster, [target]);
    const now = new Date();
    const day = dateOnlyFor(now, timeZone);
    const localMidnight = new Date(day.getTime() - 14 * HOUR_MS);
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: localMidnight, endsAt: new Date(now.getTime() + HOUR_MS), timezone: timeZone },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: localMidnight } });
    await setDailySteps(target.id, day, 1_000);
    await makeV3Hitchhike(
      raceId, caster, target,
      new Date(now.getTime() - 5 * 60 * 1000),
      new Date(now.getTime() + 55 * 60 * 1000),
    );
    await readProgress(raceId, caster);
    await setDailySteps(target.id, day, 1_500);

    const homeResponse = await request(
      server.baseUrl,
      "GET",
      "/home/race-card?homeActiveRaces=1",
      { token: caster.token, headers: { ...POWERUPS, "X-Timezone": "UTC" } },
    );
    assert.equal(homeResponse.status, 200);
    const home = await homeResponse.json();
    const card = home.data.races.find((race) => race.raceId === raceId);
    const homeCaster = card.top3.find((entry) => entry.userId === caster.id);
    assert.equal(homeCaster.totalSteps, 500);

    const progress = await readProgress(raceId, caster);
    assert.equal(participantSteps(progress, caster.id), homeCaster.totalSteps);
  });

  it("caps a coarse v3 delta to the target's canonical global-event score increase", async () => {
    const caster = await makeUser("Global Coarse Caster");
    const target = await makeUser("Global Coarse Target");
    const raceId = await createActivePowerupRace(caster, [target]);
    const now = new Date();
    const day = dateOnlyFor(now, "UTC");
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
    await setDailySteps(target.id, day, 1_000);
    const effect = await makeV3Hitchhike(
      raceId, caster, target,
      new Date(now.getTime() - 5 * 60 * 1000),
      new Date(now.getTime() + 55 * 60 * 1000),
    );
    await readProgress(raceId, caster);
    await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date(now.getTime() - 2 * 60 * 1000),
        endsAt: new Date(now.getTime() + 30 * 60 * 1000),
        multiplier: 2,
        label: "coarse cap",
      },
    });
    await setDailySteps(target.id, day, 1_500);

    const progress = await readProgress(raceId, caster);
    assert.equal(participantSteps(progress, target.id), 1_500);
    assert.equal(participantSteps(progress, caster.id), 500);
    const capture = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
      where: { effectId: effect.id },
    });
    assert.equal(capture.rawSourceKind, "COARSE_DAILY_DELTA");
    assert.equal(capture.effectiveContribution, 500);
  });

  it("freezes v3 coarse credit at finish and forfeit boundaries", async () => {
    for (const boundaryField of ["finishedAt", "forfeitedAt"]) {
      await cleanDatabase();
      const caster = await makeUser(`${boundaryField} Caster`);
      const target = await makeUser(`${boundaryField} Target`);
      const raceId = await createActivePowerupRace(caster, [target]);
      const now = new Date();
      const day = dateOnlyFor(now, "UTC");
      await prisma.race.update({
        where: { id: raceId },
        data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
      });
      await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
      await setDailySteps(target.id, day, 1_000);
      const effect = await makeV3Hitchhike(
        raceId, caster, target,
        new Date(now.getTime() - 5 * 60 * 1000),
        new Date(now.getTime() + 55 * 60 * 1000),
      );
      await readProgress(raceId, caster);
      await setDailySteps(target.id, day, 1_500);
      assert.equal(
        participantSteps(await readProgress(raceId, caster), caster.id),
        500,
      );

      const boundaryAt = new Date(Date.now() + 5);
      await prisma.raceParticipant.update({
        where: { raceId_userId: { raceId, userId: target.id } },
        data: {
          [boundaryField]: boundaryAt,
          ...(boundaryField === "finishedAt" ? { finishTotalSteps: 1_500 } : {}),
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      await setDailySteps(target.id, day, 2_000);
      const clamped = await readProgress(raceId, caster);
      assert.equal(participantSteps(clamped, caster.id), 500, boundaryField);
      const capture = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
        where: { effectId: effect.id },
      });
      assert.ok(capture.frozenAt, boundaryField);
      assert.equal(capture.effectiveContribution, 500, boundaryField);
    }
  });

  it("settles the frozen v3 capture and never reopens it after later daily sync", async () => {
    const caster = await makeUser("Settlement Caster");
    const target = await makeUser("Settlement Target");
    const raceId = await createActivePowerupRace(caster, [target]);
    const now = new Date();
    const day = dateOnlyFor(now, "UTC");
    await prisma.race.update({
      where: { id: raceId },
      data: { startedAt: day, endsAt: new Date(now.getTime() + HOUR_MS), timezone: "UTC" },
    });
    await prisma.raceParticipant.updateMany({ where: { raceId }, data: { joinedAt: day } });
    await setDailySteps(target.id, day, 1_000);
    const effect = await makeV3Hitchhike(
      raceId, caster, target,
      new Date(now.getTime() - 5 * 60 * 1000),
      new Date(now.getTime() + 55 * 60 * 1000),
    );
    await readProgress(raceId, caster);
    await setDailySteps(target.id, day, 1_500);
    const live = await readProgress(raceId, caster);
    assert.equal(participantSteps(live, caster.id), 500);

    const settlementAt = new Date(Date.now() + 5);
    await prisma.race.update({ where: { id: raceId }, data: { endsAt: settlementAt } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await resolveExpiredRaces();
    const settled = await readProgress(raceId, caster);
    assert.equal(settled.progress.status, "COMPLETED");
    assert.equal(participantSteps(settled, caster.id), 500);
    const frozen = await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
      where: { effectId: effect.id },
    });
    assert.ok(frozen.frozenAt);

    await setDailySteps(target.id, day, 2_500);
    const replay = await readProgress(raceId, caster);
    assert.equal(participantSteps(replay, caster.id), 500);
    assert.equal(
      (await prisma.hitchhikeAttributionCapture.findUniqueOrThrow({
        where: { effectId: effect.id },
      })).effectiveContribution,
      500,
    );
  });
});
