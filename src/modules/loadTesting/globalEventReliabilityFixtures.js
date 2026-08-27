const { signSessionToken } = require("../users/services/sessionToken");
const {
  assertFixtureDatabase,
  baselineIntegrity,
  cleanupSyntheticRun: cleanupGenericSyntheticRun,
} = require("./fixtures");
const {
  PROVISIONING_PROFILE,
  installationCountForUser,
  raceCountForUser,
} = require("./globalEventReliabilityProfiles");
const { localEventWindowForZone } = require("../steps/globalStepEvent");

const FIXTURE_USERS = 10_000;
const CHUNK_SIZE = 1_000;

function chunks(values, size = CHUNK_SIZE) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function provisioningWindowAfter(readyAt) {
  const earliest = new Date(readyAt.getTime() + 12 * 60 * 60_000 + 5 * 60_000);
  const latest = new Date(readyAt.getTime() + 36 * 60 * 60_000);
  for (let instant = new Date(Math.ceil(earliest.getTime() / 60_000) * 60_000);
    instant <= latest; instant = new Date(instant.getTime() + 60_000)) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(instant).filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]));
    const localStartMinute = Number(parts.hour) * 60 + Number(parts.minute);
    if (localStartMinute < 480 || localStartMinute >= 1320) continue;
    const eventDay = `${parts.year}-${parts.month}-${parts.day}`;
    return {
      eventDay,
      localStartMinute,
      ...localEventWindowForZone({
        eventDay, localStartMinute, durationMinutes: 30,
        timeZone: "America/New_York",
      }),
    };
  }
  throw new Error("global-event provisioning fixture could not find a valid planning window");
}

async function selectProvisioningParent(prisma, readyAt) {
  const earliest = new Date(readyAt.getTime() + 12 * 60 * 60_000);
  const candidates = await prisma.globalStepEvent.findMany({
    where: {
      scheduleMode: "LOCAL_ENTITLEMENTS",
      eventDay: { not: null },
      localStartMinute: { not: null },
      durationMinutes: { not: null },
    },
    orderBy: { startsAt: "asc" },
  });
  for (const event of candidates) {
    try {
      const window = localEventWindowForZone({
        eventDay: event.eventDay,
        localStartMinute: event.localStartMinute,
        durationMinutes: event.durationMinutes,
        timeZone: "America/New_York",
      });
      if (window.startsAt >= earliest) return { event, window, owned: false };
    } catch {}
  }
  return null;
}

async function collisionFreeFixtureDay(prisma, runId) {
  const seed = [...String(runId)].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const base = new Date(Date.UTC(2100 + (seed % 80), 0, 1));
  for (let offset = 0; offset < 366; offset += 1) {
    const date = new Date(base);
    date.setUTCDate(date.getUTCDate() + offset);
    const eventDay = date.toISOString().slice(0, 10);
    const existing = await prisma.globalStepEvent.findUnique({ where: { eventDay } });
    if (!existing) return eventDay;
  }
  throw new Error("global-event capacity fixture could not reserve an isolated event day");
}

async function createManyInChunks(model, rows) {
  for (const page of chunks(rows)) await model.createMany({ data: page, skipDuplicates: true });
}

function capacityRaceParticipantRows({
  userRows,
  races,
  users,
  startedAt,
  totalsUpdatedAt,
} = {}) {
  const participants = [];
  userRows.forEach((user, userIndex) => {
    for (let raceIndex = 0; raceIndex < raceCountForUser(userIndex, users); raceIndex += 1) {
      participants.push({
        raceId: races[raceIndex].id,
        userId: user.id,
        status: "ACCEPTED",
        joinedAt: startedAt,
        rawSteps: 1_000,
        totalSteps: 1_000,
        totalsUpdatedAt,
        nextBoxAtSteps: 5_000,
      });
    }
  });
  return participants;
}

async function resetGlobalEventDerivedState(prisma) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      "DELETE FROM notification_schedules WHERE type='GLOBAL_EVENT_STARTED'"
    );
    await tx.$executeRawUnsafe(
      "DELETE FROM inbox_alerts WHERE type='GLOBAL_EVENT_STARTED'"
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM domain_event_outbox
        WHERE event_type IN (
          'GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1',
          'GLOBAL_STEP_EVENT_ACTIVATED_V1'
        )`
    );
    await tx.$executeRawUnsafe("DELETE FROM global_event_user_summaries");
    await tx.$executeRawUnsafe("DELETE FROM global_event_race_impacts");
    await tx.$executeRawUnsafe("DELETE FROM global_step_event_boundary_cursors");
    await tx.$executeRawUnsafe("DELETE FROM global_step_event_entitlements");
    await tx.$executeRawUnsafe("DELETE FROM global_step_events");
    await tx.$executeRawUnsafe("DELETE FROM global_step_event_operational_snapshots");
    await tx.$executeRawUnsafe("DELETE FROM global_step_event_operational_counters");
  }, { maxWait: 10_000, timeout: 60_000 });
}

function safeUuidIds(value) {
  return (Array.isArray(value) ? value : [])
    .filter((id) => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id));
}

async function cleanupSyntheticRun({
  prisma,
  manifest,
  genericCleanup = cleanupGenericSyntheticRun,
} = {}) {
  if (!manifest || manifest.schema !== "synthetic-load-manifest-v1" ||
      !/^[a-z0-9][a-z0-9._-]{5,63}$/.test(String(manifest.runId || ""))) {
    throw new Error("capacity global-event cleanup requires a valid run manifest");
  }
  const finishGenericCleanup = async () => {
    try {
      return await genericCleanup({
        prisma,
        manifest: { ...manifest, ids: { ...manifest?.ids, globalEvents: [] } },
      });
    } catch (error) {
      // The restored clone keeps its real background cron/resolution workload.
      // Those workers may legitimately update non-synthetic baseline rows over
      // a 12-minute run. Generic cleanup checks exact synthetic ownership first,
      // so only its final whole-database checksum comparison is non-fatal here.
      if (error?.message === "baseline integrity changed during synthetic cleanup") {
        return { cleaned: true, baselineUnchanged: false, baselineDriftObserved: true };
      }
      throw error;
    }
  };
  const globalEventIds = safeUuidIds(manifest?.ids?.globalEvents);
  if (globalEventIds.length) {
    // Quiesce in a committed transaction before deleting. A scheduler tick can
    // retain an already-read parent object after this update, but no later tick
    // will select the sentinel mode. The deletion transaction below then waits
    // for any retained in-flight FK insert and removes its child before the
    // parent, closing the final select/delete race.
    const quiescedParents = await prisma.$transaction((tx) => tx.$queryRawUnsafe(
      `UPDATE global_step_events
          SET schedule_mode='CAPACITY_CLEANUP'
        WHERE id::text = ANY($1::text[])
        RETURNING id::text AS id`,
      globalEventIds,
    ), { maxWait: 5_000, timeout: 60_000 });
    const quiescedEventIds = quiescedParents.map((row) => row.id)
      .filter((id) => globalEventIds.includes(id));
    if (!quiescedEventIds.length) {
      return finishGenericCleanup();
    }
    await prisma.$transaction(async (tx) => {
      const parents = await tx.$queryRawUnsafe(
        `SELECT id::text AS id
           FROM global_step_events
          WHERE id::text = ANY($1::text[])
          ORDER BY id
          FOR UPDATE`,
        quiescedEventIds,
      );
      const lockedEventIds = parents.map((row) => row.id)
        .filter((id) => quiescedEventIds.includes(id));
      if (!lockedEventIds.length) return;

      // Locking the exact parents fences scheduler FK inserts. Locking and
      // deleting their current entitlements also drains any boundary worker
      // that already reached a synthetic child before cleanup began.
      await tx.$queryRawUnsafe(
        `SELECT id::text AS id
           FROM global_step_event_entitlements
          WHERE event_id::text = ANY($1::text[])
          ORDER BY id
          FOR UPDATE`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM global_step_event_entitlements
          WHERE event_id::text = ANY($1::text[])`,
        lockedEventIds,
      );
      // Delete the durable source before its projections. A projector already
      // holding a source row completes before this delete, after which its
      // capacity-only schedule/inbox output is removed below.
      await tx.$executeRawUnsafe(
        `DELETE FROM domain_event_outbox
          WHERE payload->>'eventId' = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM notification_schedules
          WHERE type='GLOBAL_EVENT_STARTED'
            AND payload->>'eventId' = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM inbox_alerts
          WHERE type='GLOBAL_EVENT_STARTED'
            AND destination->>'eventId' = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM global_event_user_summaries
          WHERE event_id::text = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM global_event_race_impacts
          WHERE event_id::text = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM global_step_event_boundary_cursors
          WHERE event_id::text = ANY($1::text[])`,
        lockedEventIds,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM global_step_events
          WHERE id::text = ANY($1::text[])`,
        lockedEventIds,
      );
    }, { maxWait: 5_000, timeout: 60_000 });
  }

  return finishGenericCleanup();
}

async function createGlobalEventReliabilityFixtures({
  prisma,
  runId,
  profile,
  users = FIXTURE_USERS,
  baseline = null,
  env = process.env,
  now = new Date(),
} = {}) {
  if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(String(runId || ""))) {
    throw new Error("global-event capacity fixture requires a safe run id");
  }
  assertFixtureDatabase(env);
  if (users !== FIXTURE_USERS) throw new Error("global-event capacity fixture requires exactly 10000 users");
  await resetGlobalEventDerivedState(prisma);
  const before = baseline || await baselineIntegrity(prisma);
  const ids = {
    users: [], races: [], raceParticipants: [], steps: [], stepSamples: [], globalEvents: [],
  };
  try {
    const marker = `capacity-event:${runId}`;
    await createManyInChunks(prisma.user, Array.from({ length: users }, (_, index) => ({
      appleId: `${marker}:apple:${index}`,
      email: `${marker}:${String(index).padStart(5, "0")}@synthetic.invalid`,
      displayName: `${marker}:${index}`,
      timezone: "America/New_York",
      globalEventTimezone: "America/New_York",
    })));
    const userRows = await prisma.user.findMany({
      where: { email: { startsWith: `${marker}:` } },
      orderBy: { email: "asc" },
      select: { id: true, appleId: true, email: true },
    });
    if (userRows.length !== users) throw new Error(`global-event fixture user census mismatch: ${userRows.length}`);
    ids.users.push(...userRows.map((row) => row.id));
    await createManyInChunks(prisma.userScoringInputVersion, userRows.map((user) => ({
      userId: user.id,
      generation: 1n,
      sourceQueueSemanticsGeneration: 1n,
    })));

    const startedAt = new Date(now.getTime() - 60 * 60_000);
    const endsAt = new Date(now.getTime() + 24 * 60 * 60_000);
    const races = [];
    for (let index = 0; index < 3; index += 1) {
      const race = await prisma.race.create({ data: {
        creatorId: userRows[0].id,
        name: `${marker}:race:${index}`,
        targetSteps: 1_000_000,
        status: "ACTIVE",
        startedAt,
        endsAt,
        maxDurationDays: 2,
        maxParticipants: users,
        isPublic: false,
      } });
      races.push(race);
      ids.races.push(race.id);
    }
    const participants = capacityRaceParticipantRows({
      userRows,
      races,
      users,
      startedAt,
      totalsUpdatedAt: now,
    });
    await createManyInChunks(prisma.raceParticipant, participants);
    const participantRows = await prisma.raceParticipant.findMany({
      where: { raceId: { in: ids.races } },
      orderBy: [{ raceId: "asc" }, { userId: "asc" }],
      select: { id: true, raceId: true, userId: true },
    });
    ids.raceParticipants.push(...participantRows.map((row) => row.id));
    const targetsByRace = new Map(ids.races.map((raceId) => [raceId, []]));
    for (const participant of participantRows) {
      targetsByRace.get(participant.raceId)?.push({
        raceId: participant.raceId,
        userId: participant.userId,
        participantId: participant.id,
      });
    }
    const resolutionTargetGroups = ids.races.map((raceId) => targetsByRace.get(raceId) || []);
    if (resolutionTargetGroups.some((targets) => targets.length === 0)) {
      throw new Error("global-event fixture resolution target census mismatch");
    }

    const tokens = [];
    userRows.forEach((user, userIndex) => {
      for (let installation = 0; installation < installationCountForUser(userIndex, users); installation += 1) {
        tokens.push({
          userId: user.id,
          token: `${marker}:token:${userIndex}:${installation}`,
          platform: installation % 2 === 0 ? "ios" : "android",
          installationId: `${marker}:installation:${userIndex}:${installation}`,
          lastRegisteredAt: now,
          status: "ACTIVE",
          providerEnvironment: "capacity",
        });
      }
    });
    await createManyInChunks(prisma.deviceToken, tokens);

    // Start the warmup only after the expensive 10k-user fixture is complete.
    const fixtureReadyAt = new Date();
    const warmupMs = 120_000;
    let event;
    let eventStartsAt;
    let eventEndsAt;
    if (profile === PROVISIONING_PROFILE) {
      const selected = await selectProvisioningParent(prisma, fixtureReadyAt);
      if (selected) {
        event = selected.event;
        eventStartsAt = selected.window.startsAt;
        eventEndsAt = selected.window.endsAt;
      } else {
        const provisioningWindow = provisioningWindowAfter(fixtureReadyAt);
        const collision = await prisma.globalStepEvent.findUnique({
          where: { eventDay: provisioningWindow.eventDay },
        });
        if (collision) {
          throw new Error("global-event provisioning fixture found no reusable future local parent");
        }
        eventStartsAt = provisioningWindow.startsAt;
        eventEndsAt = provisioningWindow.endsAt;
        event = await prisma.globalStepEvent.create({ data: {
          // Maintenance orders parents by this compatibility envelope. Put the
          // isolated capacity parent first so cloned/scheduler-created parents
          // cannot consume its bounded tick budget.
          startsAt: new Date(fixtureReadyAt.getTime() - 1_000),
          endsAt: eventEndsAt,
          multiplier: 2,
          label: `${marker}:event`,
          scheduleMode: "LOCAL_ENTITLEMENTS",
          eventDay: provisioningWindow.eventDay,
          localStartMinute: provisioningWindow.localStartMinute,
          durationMinutes: 30,
        } });
        ids.globalEvents.push(event.id);
      }
    } else {
      eventStartsAt = new Date(fixtureReadyAt.getTime() + warmupMs);
      eventEndsAt = new Date(eventStartsAt.getTime() + 30 * 60_000);
      event = await prisma.globalStepEvent.create({ data: {
        startsAt: eventStartsAt,
        endsAt: eventEndsAt,
        multiplier: 2,
        label: `${marker}:event`,
        scheduleMode: "LOCAL_ENTITLEMENTS",
        eventDay: await collisionFreeFixtureDay(prisma, runId),
        localStartMinute: 12 * 60,
        durationMinutes: 30,
      } });
      ids.globalEvents.push(event.id);
    }

    if (profile !== PROVISIONING_PROFILE) {
      await createManyInChunks(prisma.globalStepEventEntitlement, userRows.map((user) => ({
        eventId: event.id,
        userId: user.id,
        timezone: "America/New_York",
        localDate: eventStartsAt.toISOString().slice(0, 10),
        startsAt: eventStartsAt,
        endsAt: eventEndsAt,
      })));
      const entitlements = await prisma.globalStepEventEntitlement.findMany({
        where: { eventId: event.id }, orderBy: { userId: "asc" },
        select: { id: true, userId: true },
      });
      const eventRows = entitlements.map((entitlement) => ({
        eventKey: `GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:${entitlement.id}:0`,
        eventType: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1",
        schemaVersion: 1,
        aggregateType: "GLOBAL_STEP_EVENT_ENTITLEMENT",
        aggregateId: entitlement.id,
        occurredAt: now,
        availableAt: now,
        payload: {
          eventId: event.id,
          entitlementId: entitlement.id,
          userId: entitlement.userId,
          multiplier: 2,
          startsAt: eventStartsAt.toISOString(),
          endsAt: eventEndsAt.toISOString(),
          scheduleRevision: 0,
          timezone: "America/New_York",
        },
      }));
      await createManyInChunks(prisma.domainEventOutbox, eventRows);
      const durableEvents = await prisma.domainEventOutbox.findMany({
        where: { eventKey: { startsWith: "GLOBAL_STEP_EVENT_ENTITLEMENT_SCHEDULED_V1:" },
          aggregateId: { in: entitlements.map((row) => row.id) } },
        select: { id: true, aggregateId: true },
      });
      const userByEntitlement = new Map(entitlements.map((row) => [row.id, row.userId]));
      await createManyInChunks(prisma.domainEventAudience, durableEvents.map((row) => ({
        domainEventId: row.id,
        recipientId: userByEntitlement.get(row.aggregateId),
        ordinal: 0,
        facts: {},
      })));
    }

    return {
      baseline: before,
      manifest: { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids },
      users: userRows.map((user) => ({
        ...user,
        token: signSessionToken({ userId: user.id, appleId: user.appleId }),
      })),
      races,
      resolutionTargetGroups,
      event,
      eventStartsAt,
      eventEndsAt,
    };
  } catch (error) {
    await cleanupSyntheticRun({
      prisma,
      manifest: { schema: "synthetic-load-manifest-v1", runId, baseline: before, ids },
    }).catch(() => {});
    throw error;
  }
}

module.exports = {
  capacityRaceParticipantRows,
  cleanupSyntheticRun,
  createGlobalEventReliabilityFixtures,
  resetGlobalEventDerivedState,
  selectProvisioningParent,
};
