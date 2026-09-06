const crypto = require("node:crypto");
const { assertCapacityDatabase, assertCapacityDatabaseMarker, assertOutboundDisabled } = require("../../localCapacitySafety");
const { assertFixtureDatabase, baselineIntegrity } = require("./fixtures");
const { buildSyncBody } = require("./globalEventSyncProfiles");
const { classifyTarget } = require("./contract");
const { signSessionToken } = require("../users/services/sessionToken");
const { logicalFixtureHash } = require("./globalEventSyncAnalysis");

const FIXTURE_SCHEMA = "global-event-step-sync-fixture-v1";
const MARKER_PREFIX = "global-event-step-sync:";
const CHUNK_SIZE = 500;

function buildRunMarker(runId) { return `${MARKER_PREFIX}${runId}`; }
function chunks(rows, size = CHUNK_SIZE) { const result = []; for (let i = 0; i < rows.length; i += size) result.push(rows.slice(i, i + size)); return result; }
async function createMany(model, rows) { for (const chunk of chunks(rows)) if (chunk.length) await model.createMany({ data: chunk }); }
function normalizeGlobalEventSyncManifest(input) {
  const outer = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const nested = outer.manifest && typeof outer.manifest === "object" && !Array.isArray(outer.manifest)
    ? outer.manifest : outer;
  // v1 fixture artifacts were emitted both as the manifest itself and as a
  // wrapper containing { manifest, users }. Accept both forms, but return one
  // canonical shape so smoke/cleanup cannot silently lose the user census.
  const result = {
    ...nested,
    users: Array.isArray(nested.users) ? nested.users : (Array.isArray(outer.users) ? outer.users : []),
    ids: nested.ids || outer.ids || {},
  };
  const census = nested.census || outer.census;
  if (census !== undefined) result.census = census;
  return result;
}

async function assertGlobalEventSyncFixtureCensus({ prisma, manifest, now = new Date() } = {}) {
  const normalized = normalizeGlobalEventSyncManifest(manifest);
  if (!normalized.event?.id || !normalized.census || !normalized.ids) throw new Error("global-event fixture manifest is missing census or event IDs");
  const fixtureNow = new Date(normalized.fixtureNow || now);
  const [event, work, impacts, entitlements, races, participants, controls, samples] = await Promise.all([
    prisma.globalStepEvent.findUnique({ where: { id: normalized.event.id }, select: { id: true, endsAt: true, summaryAttributionVersion: true } }),
    prisma.globalEventSummaryWork.findMany({ where: { id: { in: normalized.ids.summaryWork || [] } }, select: { id: true, eventId: true, userId: true, status: true, expiresAt: true } }),
    prisma.globalEventRaceImpact.findMany({ where: { id: { in: normalized.ids.impacts || [] } }, select: { eventId: true, userId: true, raceId: true, status: true, attributionVersion: true } }),
    prisma.globalStepEventEntitlement.findMany({ where: { id: { in: normalized.ids.entitlements || [] } }, select: { eventId: true, userId: true, startsAt: true, endsAt: true } }),
    prisma.race.findMany({ where: { id: { in: normalized.ids.races || [] } }, select: { id: true, maxParticipants: true } }),
    prisma.raceParticipant.findMany({ where: { id: { in: normalized.ids.raceParticipants || [] }, status: "ACCEPTED" }, select: { raceId: true, userId: true } }),
    prisma.globalEventSummaryWork.findMany({ where: { eventId: normalized.event.id, userId: { in: normalized.cohorts?.controlUserIds || [] } }, select: { id: true } }),
    prisma.stepSample.count({ where: { id: { in: normalized.ids.stepSamples || [] } } }),
  ]);
  if (!event || event.summaryAttributionVersion !== 2 || new Date(event.endsAt) > fixtureNow) throw new Error("global-event fixture census event is not ended with attribution version 2");
  const expected = Number(normalized.census.eligibleSummaryWork);
  if (work.length !== expected || work.some((row) => row.eventId !== event.id || row.status !== "WAITING_SYNC" || new Date(row.expiresAt) <= fixtureNow)) throw new Error("global-event fixture census eligible work predicates mismatch");
  const treatment = new Set(normalized.cohorts?.treatmentUserIds || []);
  if (work.some((row) => !treatment.has(row.userId))) throw new Error("global-event fixture census treatment relationship mismatch");
  if (controls.length !== 0) throw new Error("global-event fixture census control cohort has eligible work");
  if (impacts.length !== expected * Number(normalized.census.races || 0) || impacts.some((row) => row.eventId !== event.id || row.status !== "PENDING" || row.attributionVersion !== 2 || !treatment.has(row.userId))) throw new Error("global-event fixture census impact predicates mismatch");
  if (entitlements.length !== expected || entitlements.some((row) => row.eventId !== event.id || new Date(row.endsAt) > fixtureNow)) throw new Error("global-event fixture census entitlement predicates mismatch");
  if (samples !== Number(normalized.census.samples)) throw new Error("global-event fixture census sample count mismatch");
  const participantsByRace = new Map();
  for (const row of participants) participantsByRace.set(row.raceId, (participantsByRace.get(row.raceId) || 0) + 1);
  const expectedSizes = normalized.census.raceSizes || [];
  if (races.length !== expectedSizes.length || races.some((race, index) => Number(race.maxParticipants) !== Number(expectedSizes[index]) || participantsByRace.get(race.id) !== Number(expectedSizes[index]))) throw new Error("global-event fixture census participant counts mismatch");
  return { eventEnded: true, attributionVersion: 2, eligibleSummaryWork: work.length, impacts: impacts.length, entitlements: entitlements.length, controlEligibleWork: controls.length, raceParticipants: participants.length, raceSizes: expectedSizes.map(Number) };
}
function fixtureCensus({ users, participantsPerRace, racesPerUser, overlap, samplesPerParticipant, eligibleSummaryCount }) {
  const sizes = arguments[0]?.raceSizes == null ? Array.from({ length: Number(racesPerUser) }, () => Number(participantsPerRace)) : arguments[0].raceSizes.map(Number);
  const races = sizes.length;
  const participants = sizes.reduce((sum, value) => sum + value, 0);
  return { users: Number(users), races, raceSizes: sizes, participants, overlap: Number(overlap), eligibleSummaryWork: Number(eligibleSummaryCount), samples: participants * Number(samplesPerParticipant), sampleDensity: Number(samplesPerParticipant), overlapParticipants: Math.round(participants * Number(overlap)) };
}

function assertGlobalEventSyncFixtureDatabase(env = process.env) {
  if (env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1") {
    assertCapacityDatabase(env.DATABASE_URL, env);
    if (env.CAPACITY_OUTBOUND_DISABLED !== "true" && env.CAPACITY_OUTBOUND_DISABLED !== "1") throw new Error("global-event fixture requires outbound delivery disabled");
    if (!env.CAPACITY_SCRUB_ATTESTATION_HASH && !env.CAPACITY_SCRUB_ATTESTATION_PATH) throw new Error("global-event fixture requires scrub attestation");
    return true;
  }
  try { return assertFixtureDatabase(env); } catch (error) {
    if (/production|public|run-bound test database/i.test(error.message)) throw new Error(`global-event fixture rejects public/production target: ${error.message}`);
    throw error;
  }
}

async function assertCapacityVmEndpoint(baseUrl, { runId, profile = "eligible-overlap", fetchImpl = globalThis.fetch } = {}) {
  classifyTarget({ target: "capacity-vm", baseUrl });
  if (typeof fetchImpl !== "function") throw new Error("capacity VM health probe requires fetch");
  const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}/health`, { headers: { Accept: "application/json", Connection: "close" } });
  if (!response?.ok) throw new Error(`capacity VM health probe failed: HTTP ${response?.status || "unknown"}`);
  const body = await response.json();
  if (body?.capacity?.runId !== runId || body?.capacity?.globalEventProfile !== profile) throw new Error("capacity VM health identity does not match run/profile");
  return { runId, profile, status: response.status };
}

function safeRunId(runId) { if (!/^[a-z0-9][a-z0-9._-]{5,63}$/.test(String(runId || ""))) throw new Error("global-event fixture requires a safe run id"); }
function cleanupOrder() { return ["domain_event_audience", "domain_event_outbox", "global_event_capture_artifacts", "global_event_summary_work", "global_event_race_impacts", "global_step_event_entitlements", "global_step_events", "race_active_effects", "race_powerup_events", "step_samples", "steps", "race_participants", "races", "user_scoring_input_versions", "users"]; }
function uuid(seed) { const hex = crypto.createHash("sha256").update(seed).digest("hex").slice(0, 32); return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`; }

async function createGlobalEventSyncFixture({ prisma, runId, config, now = new Date(), env = process.env, _transactional = false } = {}) {
  if (!_transactional && typeof prisma?.$transaction === "function") {
    return prisma.$transaction((tx) => createGlobalEventSyncFixture({ prisma: tx, runId, config, now, env, _transactional: true }), { timeout: 120_000, maxWait: 10_000 });
  }
  safeRunId(runId); assertGlobalEventSyncFixtureDatabase(env);
  if (env.CAPACITY_MODE === "true" || env.CAPACITY_MODE === "1") {
    await assertCapacityDatabaseMarker({ env });
    assertOutboundDisabled(env);
  }
  const cfg = { users: 100, controlUsers: 10, participantsPerRace: 50, racesPerUser: 2, overlap: 0.5, samplesPerParticipant: 12, sampleHistoryMinutes: 180, eligibleSummaryCount: 90, powerupEventDensity: 0.1, ...config };
  const census = fixtureCensus(cfg);
  if (census.eligibleSummaryWork > census.users - Number(cfg.controlUsers)) throw new Error("eligible summary count must leave the configured control cohort");
  if (Number(cfg.participantsPerRace) > census.users) throw new Error("participantsPerRace cannot exceed users");
  if (census.samples > 1_000_000) throw new Error("global-event fixture exceeds configured sample budget");
  const marker = buildRunMarker(runId);
  const before = await baselineIntegrity(prisma);
  const ids = { users: [], races: [], raceParticipants: [], steps: [], stepSamples: [], globalEvents: [], entitlements: [], impacts: [], summaryWork: [], summaries: [], powerups: [], activeEffects: [], powerupEvents: [], stepSyncRequests: [], raceResolutionJobs: [], raceResolutionJobsV2: [], raceResolutionFullTriggers: [], domainEvents: [], domainAudiences: [], domainProjections: [], jobRuns: [] };
  try {
  const startedAt = new Date(now.getTime() - 4 * 60 * 60_000);
  const endedAt = new Date(now.getTime() - 60 * 60_000);
  const event = await prisma.globalStepEvent.create({ data: { startsAt: startedAt, endsAt: endedAt, multiplier: 2, label: marker, scheduleMode: "LEGACY_GLOBAL", summaryAttributionVersion: 2, eventDay: `capacity-${runId}` } });
  ids.globalEvents.push(event.id);
  const userData = Array.from({ length: census.users }, (_, index) => ({ appleId: `${marker}:apple:${index}`, email: `${marker}:${index}@synthetic.invalid`, displayName: `${marker}:user:${index}`, timezone: "America/New_York", globalEventTimezone: "America/New_York", clientFeatures: ["impact_summaries", "impact_summary_expiry_v1"], lastAppVersion: "2.3.11", lastSeenAt: now }));
  await createMany(prisma.user, userData);
  const users = await prisma.user.findMany({ where: { email: { startsWith: `${marker}:` } }, orderBy: { email: "asc" }, select: { id: true, appleId: true } });
  if (users.length !== census.users) throw new Error("global-event fixture user census mismatch");
  ids.users.push(...users.map((row) => row.id));
  await createMany(prisma.userScoringInputVersion, users.map((user) => ({ userId: user.id, generation: 1n, sourceQueueSemanticsGeneration: 1n })));
  const races = [];
  for (let raceIndex = 0; raceIndex < census.races; raceIndex += 1) {
    const race = await prisma.race.create({ data: { creatorId: users[0].id, name: `${marker}:race:${raceIndex}`, targetSteps: 1_000_000, status: "ACTIVE", startedAt, endsAt: new Date(now.getTime() + 24 * 60 * 60_000), maxDurationDays: 2, maxParticipants: census.raceSizes[raceIndex], isPublic: false, powerupsEnabled: true, powerupStepInterval: 5000 } });
    races.push(race); ids.races.push(race.id);
  }
  const participants = [];
  for (let raceIndex = 0; raceIndex < races.length; raceIndex += 1) {
    const assigned = new Set();
    for (let index = 0; index < census.raceSizes[raceIndex]; index += 1) {
      const shared = index < Math.floor(census.raceSizes[raceIndex] * Number(cfg.overlap));
      let userIndex = (shared ? index : index + raceIndex * census.raceSizes[raceIndex]) % users.length;
      // A race may not contain the same user twice. The deterministic cursor
      // preserves the intended overlap while guaranteeing the composite
      // (race_id,user_id) key remains unique for every supported race shape.
      while (assigned.has(userIndex)) userIndex = (userIndex + 1) % users.length;
      assigned.add(userIndex);
      const user = users[userIndex];
      participants.push({ raceId: races[raceIndex].id, userId: user.id, status: "ACCEPTED", totalSteps: 1000 + (index % 9000), rawSteps: 1000 + (index % 9000), joinedAt: startedAt, totalsUpdatedAt: now, nextBoxAtSteps: 5000 });
    }
  }
  await createMany(prisma.raceParticipant, participants);
  const participantRows = await prisma.raceParticipant.findMany({ where: { raceId: { in: ids.races } }, select: { id: true, raceId: true, userId: true }, orderBy: [{ raceId: "asc" }, { userId: "asc" }] });
  ids.raceParticipants.push(...participantRows.map((row) => row.id));
  const sampleIntervalMs = Math.max(60_000, Math.floor(Number(cfg.sampleHistoryMinutes) * 60_000 / Number(cfg.samplesPerParticipant)));
  // step_samples is unique per user/period, so overlapping races must share a
  // user's history rather than attempting to insert duplicate rows for every
  // participant membership. Capture still reads that same history through the
  // dependency closure of each race.
  const sampleUsers = [...new Set(participantRows.map((participant) => participant.userId))];
  const sampleRows = sampleUsers.flatMap((userId) => Array.from({ length: Number(cfg.samplesPerParticipant) }, (_, sampleIndex) => { const end = new Date(now.getTime() - sampleIndex * sampleIntervalMs); return { userId, periodStart: new Date(end.getTime() - sampleIntervalMs), periodEnd: end, steps: 80 + ((sampleIndex + userId.charCodeAt(0)) % 120), sourceName: "capacity-global-event", sourceId: `${runId}:${userId}:${sampleIndex}`, recordingMethod: "automatic" }; }));
  await createMany(prisma.stepSample, sampleRows);
  const sampleIds = await prisma.stepSample.findMany({ where: { userId: { in: ids.users }, sourceName: "capacity-global-event" }, select: { id: true } });
  ids.stepSamples.push(...sampleIds.map((row) => row.id));
  census.samples = sampleRows.length;
  const dailyRows = users.map((user, index) => ({ userId: user.id, date: new Date(now.toISOString().slice(0, 10)), steps: 1000 + index }));
  await createMany(prisma.step, dailyRows);
  const stepIds = await prisma.step.findMany({ where: { userId: { in: ids.users }, date: dailyRows[0]?.date }, select: { id: true } });
  ids.steps.push(...stepIds.map((row) => row.id));
  const powerupRows = participantRows.filter((participant, index) => Number(cfg.powerupEventDensity) > 0 && (index === 0 || (index % Math.max(1, Math.round(1 / Number(cfg.powerupEventDensity))) === 0))).map((participant, index) => ({ raceId: participant.raceId, participantId: participant.id, userId: participant.userId, type: "DETOUR_SIGN", rarity: "COMMON", status: "USED", earnedAtSteps: 500 + index, usedAt: new Date(endedAt.getTime() - 10 * 60_000) }));
  await createMany(prisma.racePowerup, powerupRows);
  const powerups = await prisma.racePowerup.findMany({ where: { raceId: { in: ids.races } }, select: { id: true, raceId: true, participantId: true, userId: true } });
  ids.powerups.push(...powerups.map((row) => row.id));
  await createMany(prisma.racePowerupEvent, powerups.map((powerup) => ({ raceId: powerup.raceId, actorUserId: powerup.userId, eventType: "USED", powerupType: "DETOUR_SIGN", targetUserId: powerup.userId, description: `${marker}:powerup` })));
  const powerupEvents = await prisma.racePowerupEvent.findMany({ where: { raceId: { in: ids.races }, actorUserId: { in: ids.users } }, select: { id: true } });
  ids.powerupEvents.push(...powerupEvents.map((row) => row.id));
  await createMany(prisma.raceActiveEffect, powerups.map((powerup, index) => ({ raceId: powerup.raceId, targetParticipantId: powerup.participantId, targetUserId: powerup.userId, sourceUserId: powerup.userId, powerupId: powerup.id, type: "DETOUR_SIGN", status: index % 2 ? "EXPIRED" : "ACTIVE", startsAt: new Date(endedAt.getTime() - 30 * 60_000), expiresAt: new Date(endedAt.getTime() + (index % 2 ? -10 * 60_000 : 30 * 60_000)), metadata: { runId } })));
  const effects = await prisma.raceActiveEffect.findMany({ where: { raceId: { in: ids.races } }, select: { id: true } }); ids.activeEffects.push(...effects.map((row) => row.id));
  const treatmentUsers = users.slice(0, Number(cfg.eligibleSummaryCount));
  await createMany(prisma.globalStepEventEntitlement, treatmentUsers.map((user) => ({ eventId: event.id, userId: user.id, timezone: "America/New_York", localDate: endedAt.toISOString().slice(0, 10), startsAt: startedAt, endsAt: endedAt, startOutcome: "ACTIVATED_ON_TIME", startProcessedAt: startedAt, endProcessedAt: endedAt })));
  await createMany(prisma.globalEventRaceImpact, treatmentUsers.flatMap((user) => races.map((race) => ({ eventId: event.id, raceId: race.id, userId: user.id, status: "PENDING", attributionVersion: 2 }))));
  const entitlements = await prisma.globalStepEventEntitlement.findMany({ where: { eventId: event.id }, select: { id: true, userId: true } });
  await createMany(prisma.globalEventSummaryWork, treatmentUsers.map((user) => ({ eventId: event.id, userId: user.id, status: "WAITING_SYNC", expiresAt: new Date(now.getTime() + 24 * 60 * 60_000), requiredRaceCount: races.length, availableAt: now, nextRecoveryAt: now })));
  const workRows = await prisma.globalEventSummaryWork.findMany({ where: { eventId: event.id }, select: { id: true, userId: true } }); ids.summaryWork.push(...workRows.map((row) => row.id)); ids.entitlements.push(...entitlements.map((row) => row.id));
  const impactRows = await prisma.globalEventRaceImpact.findMany({ where: { eventId: event.id }, select: { id: true } }); ids.impacts.push(...impactRows.map((row) => row.id));
  const manifestCensus = { ...fixtureCensus({ ...cfg, participantsPerRace: cfg.participantsPerRace }), samples: sampleRows.length };
  const logicalDescriptor = { generatorVersion: FIXTURE_SCHEMA, seed: cfg.seed || runId, census: manifestCensus, profile: cfg.profile || "eligible-overlap", overlap: cfg.overlap, raceSizes: census.raceSizes, sampleHistoryMinutes: cfg.sampleHistoryMinutes, samplesPerParticipant: cfg.samplesPerParticipant, powerupEventDensity: cfg.powerupEventDensity, eligibleSummaryCount: cfg.eligibleSummaryCount, controlUsers: cfg.controlUsers, event: { multiplier: 2, summaryAttributionVersion: 2 } };
  const logicalHash = logicalFixtureHash(logicalDescriptor);
  const manifest = { schema: FIXTURE_SCHEMA, runId, profile: cfg.profile || "eligible-overlap", marker, seed: cfg.seed || runId, createdAt: now.toISOString(), fixtureNow: now.toISOString(), event: { id: event.id, startsAt: startedAt.toISOString(), endsAt: endedAt.toISOString(), ended: true, summaryAttributionVersion: 2 }, census: manifestCensus, cohorts: { controlUserIds: users.slice(Number(cfg.eligibleSummaryCount)).map((row) => row.id), treatmentUserIds: treatmentUsers.map((row) => row.id), highContentionUserIds: treatmentUsers.slice(0, Math.min(10, treatmentUsers.length)).map((row) => row.id) }, ids, before, logicalFixtureHash: logicalHash, logicalFixtureDescriptor: logicalDescriptor, payloadExample: buildSyncBody({ date: now.toISOString().slice(0, 10), now, sampleCount: cfg.samplesPerParticipant, seed: cfg.seed || runId }) };
  manifest.materializedFixtureHash = crypto.createHash("sha256").update(JSON.stringify({ logicalFixtureHash, ids })).digest("hex");
  await assertGlobalEventSyncFixtureCensus({ prisma, manifest, now });
  return { manifest, users: users.map((user, index) => ({ ...user, token: signSessionToken({ userId: user.id, appleId: user.appleId }), cohort: index < treatmentUsers.length ? "treatment" : "control" })), races, event, census };
  } catch (error) {
    if (!_transactional) await cleanupGlobalEventSyncFixture({ prisma, manifest: { schema: FIXTURE_SCHEMA, runId, ids } }).catch(() => {});
    throw error;
  }
}

async function cleanupGlobalEventSyncFixture({ prisma, manifest } = {}) {
  manifest = normalizeGlobalEventSyncManifest(manifest);
  if (!manifest || manifest.schema !== FIXTURE_SCHEMA) throw new Error("global-event cleanup requires a v1 manifest");
  safeRunId(manifest.runId); const ids = manifest.ids || {}; const inIds = (value) => Array.isArray(value) && value.length ? { in: value } : undefined;
  await prisma.$transaction(async (tx) => {
    if (inIds(ids.domainEvents)) await tx.domainEventAudience.deleteMany({ where: { domainEventId: inIds(ids.domainEvents) } });
    if (inIds(ids.domainEvents)) await tx.domainEventNotificationProjection?.deleteMany({ where: { domainEventId: inIds(ids.domainEvents) } });
    if (inIds(ids.domainEvents)) await tx.domainEventOutbox.deleteMany({ where: { id: inIds(ids.domainEvents) } });
    if (inIds(ids.summaryWork)) await tx.globalEventCaptureArtifact.deleteMany({ where: { workId: inIds(ids.summaryWork) } });
    if (inIds(ids.summaries)) await tx.globalEventUserSummary?.deleteMany({ where: { id: inIds(ids.summaries) } });
    if (inIds(ids.summaryWork)) await tx.globalEventSummaryWork.deleteMany({ where: { id: inIds(ids.summaryWork) } });
    if (inIds(ids.impacts)) await tx.globalEventRaceImpact.deleteMany({ where: { id: inIds(ids.impacts) } });
    if (inIds(ids.entitlements)) await tx.globalStepEventEntitlement.deleteMany({ where: { id: inIds(ids.entitlements) } });
    if (inIds(ids.activeEffects)) await tx.raceActiveEffect.deleteMany({ where: { id: inIds(ids.activeEffects) } });
    if (inIds(ids.powerups)) await tx.racePowerup.deleteMany({ where: { id: inIds(ids.powerups) } });
    if (inIds(ids.powerupEvents)) await tx.racePowerupEvent.deleteMany({ where: { id: inIds(ids.powerupEvents) } });
    if (inIds(ids.stepSyncRequests)) await tx.stepSyncRequest?.deleteMany({ where: { id: inIds(ids.stepSyncRequests) } });
    if (inIds(ids.raceResolutionJobs)) await tx.raceResolutionJob?.deleteMany({ where: { id: inIds(ids.raceResolutionJobs) } });
    if (inIds(ids.raceResolutionJobsV2)) await tx.raceResolutionJobV2?.deleteMany({ where: { id: inIds(ids.raceResolutionJobsV2) } });
    if (inIds(ids.raceResolutionFullTriggers)) await tx.raceResolutionFullTrigger?.deleteMany({ where: { id: inIds(ids.raceResolutionFullTriggers) } });
    if (inIds(ids.stepSamples)) await tx.stepSample.deleteMany({ where: { id: inIds(ids.stepSamples) } });
    if (inIds(ids.steps)) await tx.step.deleteMany({ where: { id: inIds(ids.steps) } });
    if (inIds(ids.raceParticipants)) await tx.raceParticipant.deleteMany({ where: { id: inIds(ids.raceParticipants) } });

    // Sync and scheduler rows are created after the fixture manifest is
    // written. Remove those rows by the manifest's parent IDs as a bounded,
    // run-scoped census; this is never a whole-table delete. FK-blocked rows
    // are retried after their children have been removed above.
    if (typeof tx.$queryRawUnsafe === "function") {
      const users = Array.isArray(ids.users) ? ids.users : [];
      const races = Array.isArray(ids.races) ? ids.races : [];
      const events = Array.isArray(ids.globalEvents) ? ids.globalEvents : [];
      if (users.length || races.length || events.length) {
        const eventPredicate = `(payload->>'userId' = ANY($1::text[]) OR payload->>'user_id' = ANY($1::text[]) OR payload->>'eventId' = ANY($2::text[]) OR payload->>'event_id' = ANY($2::text[]) OR aggregate_id = ANY($1::text[]) OR aggregate_id = ANY($3::text[]))`;
        // Sync event-bus projections are created after fixture construction,
        // so their IDs cannot be predeclared. Resolve them through the same
        // run-owned users/races/events before deleting the outbox parent.
        await tx.$executeRawUnsafe(`DELETE FROM domain_event_audiences WHERE domain_event_id IN (SELECT id FROM domain_event_outbox WHERE ${eventPredicate})`, users, events, races);
        await tx.$executeRawUnsafe(`DELETE FROM domain_event_notification_projections WHERE domain_event_id IN (SELECT id FROM domain_event_outbox WHERE ${eventPredicate})`, users, events, races);
        await tx.$executeRawUnsafe(`DELETE FROM domain_event_receipts WHERE domain_event_id IN (SELECT id FROM domain_event_outbox WHERE ${eventPredicate})`, users, events, races).catch((error) => { if (!['42P01', '42703'].includes(error?.code)) throw error; });
        await tx.$executeRawUnsafe(`DELETE FROM domain_event_outbox WHERE ${eventPredicate}`, users, events, races);
      }
      const tables = await tx.$queryRawUnsafe(`
        SELECT table_name,
               bool_or(column_name = 'user_id') AS has_user_id,
               bool_or(column_name = 'race_id') AS has_race_id,
               bool_or(column_name = 'event_id') AS has_event_id
          FROM information_schema.columns
         WHERE table_schema = 'public' AND column_name IN ('user_id','race_id','event_id')
         GROUP BY table_name ORDER BY table_name`);
      const excluded = new Set(['users', 'races', 'race_participants', 'steps', 'step_samples', 'global_step_events']);
      const array = (values) => values.length ? `ARRAY[${values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(",")}]::text[]` : "ARRAY[]::text[]";
      const pending = tables.filter((row) => !excluded.has(row.table_name));
      for (let pass = 0; pass <= pending.length; pass += 1) {
        let progress = false;
        for (const row of pending) {
          const predicates = [];
          if (row.has_user_id && users.length) predicates.push(`user_id::text = ANY(${array(users)})`);
          if (row.has_race_id && races.length) predicates.push(`race_id::text = ANY(${array(races)})`);
          if (row.has_event_id && events.length) predicates.push(`event_id::text = ANY(${array(events)})`);
          if (!predicates.length) continue;
          const table = `"${String(row.table_name).replaceAll('"', '""')}"`;
          try {
            const count = await tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE ${predicates.join(" OR ")}`);
            progress = progress || Number(count) > 0;
          } catch (error) {
            if (error?.code !== "P2003" && error?.code !== "23503") throw error;
          }
        }
        if (!progress) break;
      }
      // The smoke/load requests create additional step and sample rows after
      // the manifest is written. They are run-owned through the fixture user
      // IDs even though their row IDs cannot be predeclared. Remove them
      // before deleting users so the FK cannot strand the fixture.
      if (users.length) {
        await tx.$executeRawUnsafe(`DELETE FROM step_samples WHERE user_id::text = ANY(${array(users)})`);
        await tx.$executeRawUnsafe(`DELETE FROM steps WHERE user_id::text = ANY(${array(users)})`);
      }
      // Domain outbox payloads and job-run fences are not FK-keyed by user or
      // race columns. Their names are deterministic and include this run ID.
      await tx.$executeRawUnsafe("DELETE FROM domain_event_outbox WHERE payload->>'runId' = $1 OR payload->>'run_id' = $1", manifest.runId).catch(() => {});
      await tx.$executeRawUnsafe("DELETE FROM job_runs WHERE job_name LIKE $1 OR job_name LIKE $2", `%:${manifest.event?.id || ""}:%`, `%${manifest.runId}%`).catch(() => {});
    }
    if (inIds(ids.races)) await tx.race.deleteMany({ where: { id: inIds(ids.races) } });
    if (inIds(ids.users)) { await tx.userScoringInputVersion.deleteMany({ where: { userId: inIds(ids.users) } }); await tx.user.deleteMany({ where: { id: inIds(ids.users) } }); }
    if (inIds(ids.globalEvents)) await tx.globalStepEvent.deleteMany({ where: { id: inIds(ids.globalEvents) } });
  }, { timeout: 60_000, maxWait: 5_000 });
  const checks = await Promise.all([
    ["globalEvents", prisma.globalStepEvent.count({ where: { id: { in: ids.globalEvents || [] } } })],
    ["users", prisma.user.count({ where: { id: { in: ids.users || [] } } })],
    ["races", prisma.race.count({ where: { id: { in: ids.races || [] } } })],
    ["samples", prisma.stepSample.count({ where: { id: { in: ids.stepSamples || [] } } })],
    ["steps", prisma.step.count({ where: { id: { in: ids.steps || [] } } })],
    ["summaryWork", prisma.globalEventSummaryWork.count({ where: { id: { in: ids.summaryWork || [] } } })],
    ["artifacts", prisma.globalEventCaptureArtifact.count({ where: { workId: { in: ids.summaryWork || [] } } })],
    ["summaries", prisma.globalEventUserSummary.count({ where: { eventId: { in: ids.globalEvents || [] }, userId: { in: ids.users || [] } } })],
    ["stepSyncRequests", prisma.stepSyncRequest.count({ where: { userId: { in: ids.users || [] } } })],
    ["raceResolutionJobs", prisma.raceResolutionJob.count({ where: { userId: { in: ids.users || [] } } })],
    ["raceResolutionJobsV2", prisma.raceResolutionJobV2.count({ where: { raceId: { in: ids.races || [] } } })],
  ].map(async ([name, query]) => [name, await query]));
  const remaining = Object.fromEntries(checks.filter(([, count]) => Number(count) > 0));
  if (Object.keys(remaining).length) throw new Error(`global-event cleanup leaked manifest rows: ${JSON.stringify(remaining)}`);
  const baselineAfter = manifest.before ? await baselineIntegrity(prisma) : null;
  const baselineRestored = manifest.before ? JSON.stringify(manifest.before) === JSON.stringify(baselineAfter) : null;
  if (baselineRestored === false) throw new Error("global-event cleanup changed the pre-fixture baseline");
  return { cleaned: true, runId: manifest.runId, noWholeTableDeletes: true, remaining, baselineRestored, census: Object.fromEntries(checks) };
}

module.exports = { FIXTURE_SCHEMA, assertCapacityVmEndpoint, assertGlobalEventSyncFixtureCensus, assertGlobalEventSyncFixtureDatabase, buildRunMarker, cleanupGlobalEventSyncFixture, cleanupOrder, createGlobalEventSyncFixture, fixtureCensus, normalizeGlobalEventSyncManifest };
