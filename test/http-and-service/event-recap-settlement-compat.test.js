const assert = require("node:assert/strict");
const { beforeEach, describe, it } = require("node:test");
const { cleanDatabase, createTestUser, prisma } = require("./setup");
const { resolveExpiredRaces } = require("../../src/modules/races/jobs/raceExpiry");

// Preserved scoring/coin assertions extracted from global-event-summary-expiry-v2.
describe("event recap retirement settlement compatibility", () => {
  beforeEach(async () => cleanDatabase());
  it("race expiry retains legacy event membership and placement without recap work", async () => {
    for (const mode of ["MISSING", "PENDING_V1"]) {
      await cleanDatabase();
      const user = await createTestUser();
      const now = new Date();
      const race = await prisma.race.create({
        data: {
          creatorId: user.user.id,
          name: `v2 expiry ${mode}`,
          targetSteps: 10_000,
          status: "ACTIVE",
          startedAt: new Date(now.getTime() - 60_000),
          endsAt: new Date(now.getTime() - 1_000),
        },
      });
      await prisma.raceParticipant.create({
        data: {
          raceId: race.id,
          userId: user.user.id,
          status: "ACCEPTED",
          joinedAt: race.startedAt,
        },
      });
      const event = await prisma.globalStepEvent.create({
        data: {
          startsAt: new Date(now.getTime() - 50_000),
          endsAt: new Date(now.getTime() - 10_000),
          multiplier: 2,
        },
      });
      if (mode === "PENDING_V1") {
        await prisma.globalEventRaceImpact.create({
          data: {
            eventId: event.id,
            raceId: race.id,
            userId: user.user.id,
          },
        });
      }
      const before = await prisma.globalEventRaceImpact.findMany({
        where: { eventId: event.id, raceId: race.id, userId: user.user.id },
      });

      await resolveExpiredRaces();

      const settledRace = await prisma.race.findUniqueOrThrow({ where: { id: race.id } });
      const settledParticipant = await prisma.raceParticipant.findFirstOrThrow({
        where: { raceId: race.id, userId: user.user.id },
      });
      assert.equal(settledRace.status, "COMPLETED");
      assert.equal(settledParticipant.placement, 1);
      assert.deepEqual(await prisma.globalEventRaceImpact.findMany({
        where: { eventId: event.id, raceId: race.id, userId: user.user.id },
      }), before);
    }

    await cleanDatabase();
    const user = await createTestUser();
    const now = new Date();
    const race = await prisma.race.create({
      data: {
        creatorId: user.user.id,
        name: "v1 expiry retained",
        targetSteps: 10_000,
        status: "ACTIVE",
        startedAt: new Date(now.getTime() - 60_000),
        endsAt: new Date(now.getTime() - 1_000),
      },
    });
    await prisma.raceParticipant.create({
      data: {
        raceId: race.id,
        userId: user.user.id,
        status: "ACCEPTED",
        joinedAt: race.startedAt,
      },
    });
    const event = await prisma.globalStepEvent.create({
      data: {
        startsAt: new Date(now.getTime() - 50_000),
        endsAt: new Date(now.getTime() - 10_000),
        multiplier: 2,
        scheduleMode: "LOCAL_ENTITLEMENTS",
      },
    });
    await prisma.globalStepEventEntitlement.create({
      data: {
        eventId: event.id,
        userId: user.user.id,
        timezone: "UTC",
        localDate: event.startsAt.toISOString().slice(0, 10),
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        startOutcome: "ACTIVATED_ON_TIME",
        startProcessedAt: event.startsAt,
      },
    });
    await prisma.globalEventRaceImpact.create({
      data: {
        eventId: event.id,
        raceId: race.id,
        userId: user.user.id,
      },
    });
    await resolveExpiredRaces();
    const legacyImpact = await prisma.globalEventRaceImpact.findUniqueOrThrow({
      where: {
        eventId_raceId_userId: {
          eventId: event.id,
          raceId: race.id,
          userId: user.user.id,
        },
      },
    });
    assert.equal(legacyImpact.eventId, event.id);
    assert.equal((await prisma.race.findUniqueOrThrow({ where: { id: race.id } })).status, "COMPLETED");
  });

  it("settles local event scores and coins with existing or missing event membership", async () => {
    for (const workStatus of ["WAITING_RACES", "UNSCORABLE"]) {
      for (const impactMode of ["EXISTING", "MISSING"]) {
        await cleanDatabase();
        const user = await createTestUser();
        const now = new Date();
        const raceStartedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
        const eventStartsAt = new Date(now.getTime() - 90 * 60 * 1000);
        const eventEndsAt = new Date(now.getTime() - 30 * 60 * 1000);
        const sampleStartsAt = new Date(eventStartsAt.getTime() + 10 * 60 * 1000);
        const sampleEndsAt = new Date(sampleStartsAt.getTime() + 10 * 60 * 1000);
        const race = await prisma.race.create({
          data: {
            creatorId: user.user.id,
            name: `local fenced ${workStatus} ${impactMode}`,
            targetSteps: 10_000,
            status: "ACTIVE",
            startedAt: raceStartedAt,
            endsAt: new Date(now.getTime() - 1_000),
            buyInAmount: 10,
            potCoins: 10,
          },
        });
        await prisma.raceParticipant.create({
          data: {
            raceId: race.id,
            userId: user.user.id,
            status: "ACCEPTED",
            joinedAt: raceStartedAt,
            buyInAmount: 10,
            buyInStatus: "COMMITTED",
          },
        });
        const event = await prisma.globalStepEvent.create({
          data: {
            startsAt: eventStartsAt,
            endsAt: eventEndsAt,
            multiplier: 2,
            scheduleMode: "LOCAL_ENTITLEMENTS",
            eventDay: `${now.toISOString().slice(0, 10)}-${workStatus}-${impactMode}`,
          },
        });
        await prisma.globalStepEventEntitlement.create({
          data: {
            eventId: event.id,
            userId: user.user.id,
            timezone: "UTC",
            localDate: eventStartsAt.toISOString().slice(0, 10),
            startsAt: eventStartsAt,
            endsAt: eventEndsAt,
            startOutcome: "ACTIVATED_ON_TIME",
            startProcessedAt: eventStartsAt,
          },
        });
        if (impactMode === "EXISTING") {
          await prisma.globalEventRaceImpact.create({
            data: {
              eventId: event.id,
              raceId: race.id,
              userId: user.user.id,
            },
          });
        }
        await prisma.stepSample.create({
          data: {
            userId: user.user.id,
            periodStart: sampleStartsAt,
            periodEnd: sampleEndsAt,
            steps: 100,
          },
        });
        const beforeVector = await prisma.globalEventRaceImpact.findMany({
          where: { eventId: event.id, userId: user.user.id },
          orderBy: { raceId: "asc" },
        });
        const beforeCoins = (await prisma.user.findUniqueOrThrow({
          where: { id: user.user.id },
          select: { coins: true },
        })).coins;

        await resolveExpiredRaces();

        const settledRace = await prisma.race.findUniqueOrThrow({ where: { id: race.id } });
        const settledParticipant = await prisma.raceParticipant.findFirstOrThrow({
          where: { raceId: race.id, userId: user.user.id },
        });
        const settledCoins = (await prisma.user.findUniqueOrThrow({
          where: { id: user.user.id },
          select: { coins: true },
        })).coins;
        assert.equal(settledRace.status, "COMPLETED");
        assert.equal(settledRace.winnerUserId, user.user.id);
        assert.equal(settledParticipant.placement, 1);
        assert.equal(settledParticipant.totalSteps, 200,
          "100 event-window steps settle at the entitled 2x multiplier");
        assert.equal(settledParticipant.payoutCoins, 10);
        assert.equal(settledCoins, beforeCoins + 10);
        const retainedMembership = await prisma.globalEventRaceImpact.findMany({
          where: { eventId: event.id, userId: user.user.id },
          orderBy: { raceId: "asc" },
        });
        if (impactMode === 'EXISTING') assert.deepEqual(retainedMembership, beforeVector);
        else assert.deepEqual(retainedMembership.map(({ eventId, raceId, userId }) => ({ eventId, raceId, userId })),
          [{ eventId: event.id, raceId: race.id, userId: user.user.id }],
          'ordinary settlement repairs missing membership; no retired captured-vector fence remains');
      }
    }
  });
});
