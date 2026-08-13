const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { describe, it, before, beforeEach } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const FEATURES = {
  "X-Client-Features": "powerups2,powerups3,powerups4,powerups5",
};

let server;

async function createRace({ creatorId, powerupsEnabled = true } = {}) {
  return prisma.race.create({
    data: {
      creatorId,
      name: `Performance ${randomUUID()}`,
      targetSteps: 100000,
      status: "ACTIVE",
      startedAt: new Date(Date.now() - 60_000),
      endsAt: new Date(Date.now() + 86_400_000),
      timezone: "UTC",
      powerupsEnabled,
      powerupStepInterval: powerupsEnabled ? 1000 : null,
      maxParticipants: null,
    },
  });
}

describe("race powerup and placement performance public/integration contract", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(cleanDatabase);

  it("returns the unchanged sneaky-target envelope and joinedAt order over real HTTP at 300 candidates", async () => {
    const { user: viewer, token } = await createTestUser({
      displayName: "PerfViewer",
    });
    const race = await createRace({ creatorId: viewer.id });
    const viewerParticipantId = randomUUID();
    const candidates = Array.from({ length: 300 }, (_, index) => ({
      userId: randomUUID(),
      participantId: randomUUID(),
      displayName: `PerfCandidate${String(index).padStart(3, "0")}`,
      joinedAt: new Date(Date.now() - (300 - index) * 1000),
    }));

    await prisma.user.createMany({
      data: candidates.map((candidate) => ({
        id: candidate.userId,
        appleId: `perf-${candidate.userId}`,
        displayName: candidate.displayName,
      })),
    });
    await prisma.raceParticipant.createMany({
      data: [
        {
          id: viewerParticipantId,
          raceId: race.id,
          userId: viewer.id,
          status: "ACCEPTED",
          joinedAt: new Date(Date.now() - 1_000_000),
        },
        ...candidates.map((candidate) => ({
          id: candidate.participantId,
          raceId: race.id,
          userId: candidate.userId,
          status: "ACCEPTED",
          joinedAt: candidate.joinedAt,
        })),
      ],
    });

    // Only three candidates own stealable inventory; the middle one is
    // stealthed and therefore absent. A HELD SNEAKY_SWAP is not stealable.
    const visible = [candidates[2], candidates[200]];
    const hiddenStealthed = candidates[100];
    const rows = [...visible, hiddenStealthed];
    const powerupIds = rows.map(() => randomUUID());
    await prisma.racePowerup.createMany({
      data: rows.map((candidate, index) => ({
        id: powerupIds[index],
        raceId: race.id,
        participantId: candidate.participantId,
        userId: candidate.userId,
        type: "SHORTCUT",
        rarity: "COMMON",
        status: "HELD",
        earnedAtSteps: 1000 + index,
      })),
    });
    await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: candidates[50].participantId,
        userId: candidates[50].userId,
        type: "SNEAKY_SWAP",
        rarity: "COMMON",
        status: "HELD",
        earnedAtSteps: 2000,
      },
    });
    await prisma.raceActiveEffect.create({
      data: {
        raceId: race.id,
        targetParticipantId: hiddenStealthed.participantId,
        targetUserId: hiddenStealthed.userId,
        sourceUserId: viewer.id,
        powerupId: powerupIds[2],
        type: "STEALTH_MODE",
        status: "ACTIVE",
        startsAt: new Date(Date.now() - 1000),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const response = await request(
      server.baseUrl,
      "GET",
      `/races/${race.id}/powerups/sneaky-swap-targets`,
      { token }
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      targets: visible.map((candidate) => ({
        userId: candidate.userId,
        displayName: candidate.displayName,
      })),
    });
  });

  it("preserves fresh-open/replay JSON while normal open repairs drift and oldest queued inventory", async () => {
    const { user, token } = await createTestUser();
    const race = await createRace({ creatorId: user.id });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        bonusSteps: 200,
        maxBonusSteps: 100,
        powerupSlots: 2,
      },
    });
    const box = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: "MYSTERY_BOX",
        status: "MYSTERY_BOX",
        earnedAtSteps: 1000,
      },
    });
    const oldestQueued = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: "MYSTERY_BOX",
        status: "QUEUED",
        earnedAtSteps: 2000,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    const newestQueued = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: "MYSTERY_BOX",
        status: "QUEUED",
        earnedAtSteps: 3000,
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    });

    const response = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${box.id}/open`,
      { token, headers: FEATURES }
    );
    assert.equal(response.status, 200);
    const fresh = (await response.json()).result;
    assert.deepEqual(Object.keys(fresh).sort(), [
      "autoActivated",
      "id",
      "rarity",
      "type",
    ]);
    assert.equal(fresh.id, box.id);
    assert.equal(fresh.autoActivated, false);
    assert.ok(fresh.type && fresh.type !== "MYSTERY_BOX");
    assert.ok(["COMMON", "UNCOMMON", "RARE"].includes(fresh.rarity));

    const repaired = await prisma.raceParticipant.findUnique({
      where: { id: participant.id },
    });
    assert.equal(repaired.maxBonusSteps, 200);
    const boxes = await prisma.racePowerup.findMany({
      where: { id: { in: [oldestQueued.id, newestQueued.id] } },
      orderBy: { createdAt: "asc" },
    });
    assert.deepEqual(boxes.map((box) => box.status), ["MYSTERY_BOX", "QUEUED"]);

    const replayResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/${box.id}/open`,
      { token, headers: FEATURES }
    );
    assert.equal(replayResponse.status, 200);
    assert.deepEqual((await replayResponse.json()).result, {
      id: fresh.id,
      type: fresh.type,
      rarity: fresh.rarity,
      autoActivated: false,
      alreadyOpened: true,
    });
    assert.equal(
      await prisma.racePowerupEvent.count({
        where: {
          raceId: race.id,
          eventType: "MYSTERY_BOX_OPENED",
        },
      }),
      1
    );
  });

  it("keeps narrow repair inert through every public guard", async () => {
    const guardCases = [
      { name: "inactive", race: { status: "PENDING" }, expectedStatus: 400 },
      { name: "disabled", race: { powerupsEnabled: false, powerupStepInterval: null }, expectedStatus: 200 },
      { name: "null interval", race: { powerupStepInterval: null }, expectedStatus: 200 },
      { name: "zero interval", race: { powerupStepInterval: 0 }, expectedStatus: 200 },
      { name: "invited", participantStatus: "INVITED", expectedStatus: 200 },
      { name: "declined", participantStatus: "DECLINED", expectedStatus: 200 },
    ];

    for (const guard of guardCases) {
      const { user, token } = await createTestUser();
      const race = await createRace({ creatorId: user.id });
      if (guard.race) {
        await prisma.race.update({ where: { id: race.id }, data: guard.race });
      }
      const participant = await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: user.id,
          status: guard.participantStatus || "ACCEPTED",
          bonusSteps: 500,
          maxBonusSteps: 100,
          powerupSlots: 3,
        },
      });
      const box = await prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participant.id,
          userId: user.id,
          type: "MYSTERY_BOX",
          status: "MYSTERY_BOX",
          earnedAtSteps: 1000,
        },
      });
      const queued = await prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participant.id,
          userId: user.id,
          type: "MYSTERY_BOX",
          status: "QUEUED",
          earnedAtSteps: 2000,
        },
      });

      const response = await request(
        server.baseUrl,
        "POST",
        `/races/${race.id}/powerups/${box.id}/open`,
        { token, headers: FEATURES }
      );
      assert.equal(response.status, guard.expectedStatus, guard.name);
      const persistedParticipant = await prisma.raceParticipant.findUnique({
        where: { id: participant.id },
      });
      const persistedQueued = await prisma.racePowerup.findUnique({
        where: { id: queued.id },
      });
      assert.equal(persistedParticipant.maxBonusSteps, 100, guard.name);
      assert.equal(persistedQueued.status, "QUEUED", guard.name);
    }
  });

  it("keeps batch request order, the hard cap, and lazy inactive-race validation", async () => {
    const { user, token } = await createTestUser();
    const race = await createRace({ creatorId: user.id });
    const participant = await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED", powerupSlots: 25 },
    });
    const boxes = [];
    for (let index = 0; index < 22; index += 1) {
      boxes.push(await prisma.racePowerup.create({
        data: {
          raceId: race.id,
          participantId: participant.id,
          userId: user.id,
          type: "PROTEIN_SHAKE",
          rarity: "COMMON",
          status: "HELD",
          earnedAtSteps: 1000 + index,
        },
      }));
    }
    const requested = boxes.map((box) => box.id).reverse();
    const cappedResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/open-batch`,
      { token, headers: FEATURES, body: { powerupIds: requested, maxCount: 999 } }
    );
    assert.equal(cappedResponse.status, 200);
    const capped = await cappedResponse.json();
    assert.equal(capped.results.length, 20);
    assert.deepEqual(
      capped.results.map((result) => result.powerupId),
      requested.slice(0, 20)
    );

    await prisma.race.update({ where: { id: race.id }, data: { status: "PENDING" } });
    const lazyResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/open-batch`,
      { token, headers: FEATURES, body: { powerupIds: [randomUUID()], maxCount: 20 } }
    );
    assert.equal(lazyResponse.status, 200);
    assert.deepEqual((await lazyResponse.json()).results, []);

    const unopened = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        status: "MYSTERY_BOX",
        earnedAtSteps: 5000,
      },
    });
    const validatedResponse = await request(
      server.baseUrl,
      "POST",
      `/races/${race.id}/powerups/open-batch`,
      { token, headers: FEATURES, body: { powerupIds: [unopened.id], maxCount: 20 } }
    );
    assert.equal(validatedResponse.status, 400);
  });

  it("preserves the current concurrent double-open behavior", async () => {
    const { user, token } = await createTestUser();
    const race = await createRace({ creatorId: user.id });
    const participant = await prisma.raceParticipant.create({
      data: { raceId: race.id, userId: user.id, status: "ACCEPTED" },
    });
    const box = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        status: "MYSTERY_BOX",
        earnedAtSteps: 1000,
      },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION perf_pause_box_open() RETURNS trigger AS $$
      BEGIN
        IF OLD.status::text = 'mystery_box' AND NEW.status::text IN ('held', 'used') THEN
          PERFORM pg_sleep(0.05);
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER perf_pause_box_open_trigger
      BEFORE UPDATE ON race_powerups
      FOR EACH ROW EXECUTE FUNCTION perf_pause_box_open()
    `);
    try {
      const responses = await Promise.all([
        request(server.baseUrl, "POST", `/races/${race.id}/powerups/${box.id}/open`, {
          token,
          headers: FEATURES,
        }),
        request(server.baseUrl, "POST", `/races/${race.id}/powerups/${box.id}/open`, {
          token,
          headers: FEATURES,
        }),
      ]);
      assert.deepEqual(responses.map((response) => response.status), [200, 200]);
      assert.equal(
        await prisma.racePowerupEvent.count({
          where: { raceId: race.id, eventType: "MYSTERY_BOX_OPENED" },
        }),
        2,
        "this performance scope intentionally does not close the known double-open exploit"
      );
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS perf_pause_box_open_trigger ON race_powerups"
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS perf_pause_box_open()" );
    }
  });

  it("use-time repair refreshes capacity after a concurrent participant change", async () => {
    const { user, token } = await createTestUser();
    const race = await createRace({ creatorId: user.id });
    const participant = await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.id,
        status: "ACCEPTED",
        powerupSlots: 1,
      },
    });
    const held = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        type: "PROTEIN_SHAKE",
        rarity: "COMMON",
        status: "HELD",
        earnedAtSteps: 1000,
      },
    });
    const queued = await prisma.racePowerup.create({
      data: {
        raceId: race.id,
        participantId: participant.id,
        userId: user.id,
        status: "QUEUED",
        earnedAtSteps: 2000,
      },
    });
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION perf_expand_slots_on_use() RETURNS trigger AS $$
      BEGIN
        IF OLD.status::text = 'held' AND NEW.status::text = 'used' THEN
          UPDATE race_participants SET powerup_slots = 2 WHERE id = NEW.participant_id;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER perf_expand_slots_on_use_trigger
      AFTER UPDATE ON race_powerups
      FOR EACH ROW EXECUTE FUNCTION perf_expand_slots_on_use()
    `);
    try {
      const response = await request(
        server.baseUrl,
        "POST",
        `/races/${race.id}/powerups/${held.id}/use`,
        { token, headers: FEATURES }
      );
      assert.equal(response.status, 200);
      const [freshParticipant, freshQueued] = await Promise.all([
        prisma.raceParticipant.findUnique({ where: { id: participant.id } }),
        prisma.racePowerup.findUnique({ where: { id: queued.id } }),
      ]);
      assert.equal(freshParticipant.powerupSlots, 2);
      assert.equal(freshQueued.status, "MYSTERY_BOX");
    } finally {
      await prisma.$executeRawUnsafe(
        "DROP TRIGGER IF EXISTS perf_expand_slots_on_use_trigger ON race_powerups"
      );
      await prisma.$executeRawUnsafe("DROP FUNCTION IF EXISTS perf_expand_slots_on_use()" );
    }
  });
});
