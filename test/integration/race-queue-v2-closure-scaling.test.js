// Dependency closure — PHASE 3 scaling and query-plan evidence.
//
// Spec test plan items 7 and 13. Two claims are under test, and they are
// different claims:
//
//   * COST SHAPE — the candidate and fence graph reads are a bounded CONSTANT
//     number of race-scoped scans, and score computation/writes are O(C) where
//     C is the closure size, NOT O(N) in the field size. The proof is that
//     every measured count is IDENTICAL at 10, 100 and 350 participants. A
//     threshold like "fewer than 20 queries" would pass even if the count grew
//     with N, so the assertion is equality across sizes, not a bound.
//
//   * PLAN SHAPE — the accepted-member scan, the effect-history scan and the
//     fingerprint's per-member sample-boundary subselect all reach their rows
//     through an index, on a table populated enough for Postgres to prefer a
//     sequential scan if no usable index existed.
//
// The uploader is a real user driving a real HTTP sync through the real worker.
// Filler participants are inserted directly: 350 signup round-trips would make
// this suite minutes long and would test the signup path, not the closure.

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

process.env.RACE_QUEUE_V2_QUIET_PERIOD_MS = "0";
process.env.RACE_RESOLVE_DEBOUNCE_MS = "0";

const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildRaceResolutionWorkerV2,
} = require("../../src/modules/races/jobs/raceResolutionQueueV2");
const {
  buildRaceResolutionInputFingerprint,
} = require("../../src/modules/races/services/raceResolutionInputFingerprint");
const { Race } = require("../../src/modules/races/models/race");
const {
  RaceActiveEffect,
} = require("../../src/modules/powerups/models/raceActiveEffect");
const { appSettings } = require("../../src/shared/config/appSettings");

const WRITE_FLAG = "raceResolutionDependencyClosureV1Enabled";
const HOUR_MS = 60 * 60 * 1000;

let server;
let seq = 0;

before(async () => {
  server = await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  await prisma.globalStepEvent.deleteMany({});
  await appSettings.setFlag("raceQueueV2ClaimingDisabled", false);
  await appSettings.setFlag("inlineRaceResolutionFallback", false);
  await appSettings.setFlag("raceResolutionBulkWriteV1Enabled", false);
  await appSettings.setFlag("raceResolutionBurstCoalescingV1Enabled", false);
  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", false);
  await appSettings.setFlag("raceResolutionPostTasksV1Enabled", false);
  await appSettings.setFlag("raceResolutionDependencyClosureShadowV1Enabled", false);
  await appSettings.setFlag(WRITE_FLAG, false);
});

after(async () => {
  await appSettings.setFlag(WRITE_FLAG, false);
});

// ── fixtures ───────────────────────────────────────────────────────────────

async function createUser(displayName) {
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: `apple-scale-${++seq}-${Date.now()}` },
  });
  const body = await res.json();
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token: body.sessionToken,
  });
  return { userId: body.user.id, token: body.sessionToken };
}

function sampleAt(hoursAgo, steps) {
  const end = new Date(Date.now() - hoursAgo * HOUR_MS);
  return {
    periodStart: new Date(end.getTime() - HOUR_MS).toISOString(),
    periodEnd: end.toISOString(),
    steps,
  };
}

/**
 * A race of `size` accepted participants: two real HTTP users (the uploader and
 * the Leech partner who forms the closure's only edge) plus `size - 2` filler
 * rows inserted directly, each carrying real step samples so the scans below
 * have something to scan.
 */
async function seedRaceOfSize(size) {
  const uploader = await createUser(`Uploader${size}`);
  const partner = await createUser(`Partner${size}`);

  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: partner.userId },
    token: uploader.token,
  });
  const friendship = (await sendRes.json()).friendship;
  await request(server.baseUrl, "PUT", `/friends/request/${friendship.id}`, {
    body: { accept: true },
    token: partner.token,
  });

  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: `Scale ${size}`,
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
      // null == unlimited. The validator caps an explicit number at 100, and
      // the filler rows below are inserted directly anyway.
      maxParticipants: null,
    },
    token: uploader.token,
  });
  const created = await createRes.json();
  assert.ok(created.race, `race creation failed: ${JSON.stringify(created)}`);
  const raceId = created.race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: [partner.userId] },
    token: uploader.token,
  });
  await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
    body: { accept: true },
    token: partner.token,
  });
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
    token: uploader.token,
  });

  const startedAt = new Date(Date.now() - 8 * HOUR_MS);
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt,
      endsAt: new Date(Date.now() + 24 * HOUR_MS),
      timezone: "UTC",
    },
  });

  // Filler field.
  const fillerCount = Math.max(0, size - 2);
  const tag = `fill${size}x${++seq}`;
  const users = [];
  const participants = [];
  const samples = [];
  const versions = [];
  for (let i = 0; i < fillerCount; i++) {
    const userId = `${tag}-u${i}`;
    users.push({ id: userId, appleId: `${tag}-a${i}`, displayName: `Filler ${i}` });
    participants.push({
      id: `${tag}-p${i}`,
      raceId,
      userId,
      status: "ACCEPTED",
      joinedAt: startedAt,
      totalSteps: 1000 + i,
      rawSteps: 1000 + i,
    });
    versions.push({ userId, generation: BigInt(i + 1) });
    // Four closed hourly buckets each: enough rows that a sequential scan of
    // step_samples is a real alternative for the planner.
    for (let h = 2; h < 6; h++) {
      const end = new Date(Date.now() - h * HOUR_MS);
      samples.push({
        id: `${tag}-s${i}-${h}`,
        userId,
        periodStart: new Date(end.getTime() - HOUR_MS),
        periodEnd: end,
        steps: 200 + h,
      });
    }
  }
  if (users.length) {
    await prisma.user.createMany({ data: users });
    await prisma.raceParticipant.createMany({ data: participants });
    await prisma.stepSample.createMany({ data: samples });
    await prisma.userScoringInputVersion.createMany({ data: versions });
  }
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt },
  });

  return { raceId, uploader, partner };
}

// ── measurement ────────────────────────────────────────────────────────────

// Counts calls on the REAL models the worker already takes as dependencies.
// This wraps, it does not replace: every call still reaches the shipped model
// and the shipped SQL, so the run under measurement is the real one.
function counting(model, names, counters) {
  // A PLAIN object with every method copied as an own, ENUMERABLE property.
  // Not `Object.create(model)`: the worker hands these models to
  // `createWriteCapture`, which spreads them — and a spread copies only own
  // enumerable properties, so a prototype-delegating wrapper would arrive at
  // the capture with no methods at all.
  const wrapper = {};
  for (const key in model) {
    if (typeof model[key] === "function") wrapper[key] = model[key].bind(model);
  }
  for (const key of Object.getOwnPropertyNames(model)) {
    if (typeof model[key] === "function" && !wrapper[key]) {
      wrapper[key] = model[key].bind(model);
    }
  }
  for (const name of names) {
    if (typeof model[name] !== "function") continue;
    wrapper[name] = (...args) => {
      counters[name] = (counters[name] || 0) + 1;
      return model[name](...args);
    };
  }
  return wrapper;
}

async function participantVersions(raceId) {
  return prisma.$queryRawUnsafe(
    `SELECT id, xmin::text AS version FROM race_participants
     WHERE race_id = $1 ORDER BY id ASC`,
    raceId
  );
}

function changedRowIds(before, after) {
  const beforeById = new Map(before.map((row) => [row.id, row.version]));
  return after
    .filter((row) => beforeById.get(row.id) !== row.version)
    .map((row) => row.id)
    .sort();
}

/** Seeds a race of `size`, runs ONE closure generation, and measures it. */
async function measureClosureAtSize(size) {
  const { raceId, uploader, partner } = await seedRaceOfSize(size);

  // The leech transfer is floor(attacker's in-window steps / ratio), so the
  // partner needs real walked steps or the closure would compute a zero
  // transfer, write nothing, and the O(C) measurement would be of an empty set.
  assert.equal(
    (await request(server.baseUrl, "POST", "/steps/samples", {
      body: { samples: [sampleAt(5, 6000), sampleAt(4, 5000)] },
      token: partner.token,
    })).status,
    200
  );

  // Baseline FULL resolution of the whole field.
  const baseline = buildRaceResolutionWorkerV2({ bootAt: 0, logger: { log() {}, error() {} } });
  for (let i = 0; i < 20 && (await baseline.processOne()); i++) { /* drain */ }

  // The closure's single edge: the partner leeches the uploader.
  const [targetParticipant, sourceParticipant] = await Promise.all([
    prisma.raceParticipant.findFirstOrThrow({ where: { raceId, userId: uploader.userId } }),
    prisma.raceParticipant.findFirstOrThrow({ where: { raceId, userId: partner.userId } }),
  ]);
  const powerup = await prisma.racePowerup.create({
    data: {
      raceId, participantId: sourceParticipant.id, userId: partner.userId,
      type: "LEECH", status: "USED", usedAt: new Date(), targetUserId: uploader.userId,
    },
  });
  await prisma.raceActiveEffect.create({
    data: {
      raceId,
      targetParticipantId: targetParticipant.id,
      targetUserId: uploader.userId,
      sourceUserId: partner.userId,
      powerupId: powerup.id,
      type: "LEECH",
      status: "ACTIVE",
      startsAt: new Date(Date.now() - 6 * HOUR_MS),
      expiresAt: new Date(Date.now() + HOUR_MS),
    },
  });

  await appSettings.setFlag("raceResolutionReasonAwareV1Enabled", true);
  await appSettings.setFlag(WRITE_FLAG, true);

  const res = await request(server.baseUrl, "POST", "/steps/samples", {
    body: { samples: [sampleAt(3, 9000)] },
    token: uploader.token,
  });
  assert.equal(res.status, 200);

  const counters = {};
  const lines = [];
  const errors = [];
  const versionsBefore = await participantVersions(raceId);
  const closureParticipantIds = [targetParticipant.id, sourceParticipant.id].sort();
  const worker = buildRaceResolutionWorkerV2({
    bootAt: 0,
    logger: {
      log: (line) => { try { lines.push(JSON.parse(line)); } catch { /* noise */ } },
      // Captured, not swallowed: a worker error here would otherwise surface
      // only as a missing commit line with no cause.
      error: (...args) => { errors.push(args.map(String).join(" ")); },
    },
    Race: counting(Race, ["findById", "findForResolution"], counters),
    RaceActiveEffect: counting(
      RaceActiveEffect,
      ["findActiveForRace", "findRaceEffectsByType", "findEffectsForRaceByTypes"],
      counters
    ),
    buildRaceResolutionInputFingerprint: (...args) => {
      counters.fingerprint = (counters.fingerprint || 0) + 1;
      return buildRaceResolutionInputFingerprint(...args);
    },
  });
  assert.ok(await worker.processOne());
  const versionsAfter = await participantVersions(raceId);

  const line = lines.find(
    (row) => row.event === "race_resolution_v2" && row.outcome === "commit"
  );
  assert.ok(
    line,
    `size ${size}: no commit line. worker errors:\n${errors.join("\n") || "(none)"}`
  );
  return {
    raceId,
    line,
    counters,
    changedIds: changedRowIds(versionsBefore, versionsAfter),
    closureParticipantIds,
    fieldSize: versionsAfter.length,
  };
}

// ── 1. the 10 / 100 / 350 matrix ───────────────────────────────────────────

describe("dependency closure — 10/100/350 scaling", () => {
  it("graph reads stay a bounded constant and writes stay O(C) as the field grows 35x", async () => {
    const sizes = [10, 100, 350];
    const measured = [];
    for (const size of sizes) {
      await cleanDatabase();
      measured.push({ size, ...(await measureClosureAtSize(size)) });
    }

    for (const run of measured) {
      assert.ok(run.line, `size ${run.size}: the generation must have committed`);
      assert.equal(
        run.line.resolutionPlan,
        "DEPENDENCY_CLOSURE",
        `size ${run.size}: must have taken the closure plan, else the measurement is of FULL`
      );
      assert.equal(
        run.fieldSize,
        run.size,
        `size ${run.size}: the field must actually be that big`
      );
      assert.equal(
        run.line.fullParticipantCount,
        run.size,
        `size ${run.size}: the result must still carry the FULL roster (R9)`
      );
      // O(C): every row the generation wrote is a closure member, at any field
      // size. The closure here is {uploader, leech partner}; the uploader's own
      // row may already be current because `reconcileUploaderRaces` persists it
      // inline, and the worker correctly skips a no-op write — so the assertion
      // is containment plus non-emptiness, not an exact count of 2.
      assert.ok(
        run.changedIds.length > 0,
        `size ${run.size}: the generation must have written something, else O(C) is vacuous`
      );
      for (const id of run.changedIds) {
        assert.ok(
          run.closureParticipantIds.includes(id),
          `size ${run.size}: wrote participant ${id}, which is NOT in the closure`
        );
      }
    }

    // Writes do not grow with the field either.
    assert.equal(measured[1].changedIds.length, measured[0].changedIds.length,
      "the number of written rows must not grow from 10 to 100 participants");
    assert.equal(measured[2].changedIds.length, measured[0].changedIds.length,
      "the number of written rows must not grow from 10 to 350 participants");

    // The load-bearing assertion: IDENTICAL counts across a 35x field. A count
    // that grew with N would still satisfy any fixed upper bound.
    const shape = (run) => JSON.stringify(run.counters, Object.keys(run.counters).sort());
    assert.equal(
      shape(measured[1]),
      shape(measured[0]),
      `race-scoped read counts must not grow from 10 to 100 participants:\n` +
        `  10  => ${shape(measured[0])}\n  100 => ${shape(measured[1])}`
    );
    assert.equal(
      shape(measured[2]),
      shape(measured[0]),
      `race-scoped read counts must not grow from 10 to 350 participants:\n` +
        `  10  => ${shape(measured[0])}\n  350 => ${shape(measured[2])}`
    );

    // Candidate read + mandatory fence re-verify. Exactly two, never per-member.
    assert.equal(
      measured[2].counters.fingerprint,
      2,
      "one candidate fingerprint plus one in-fence re-verify — no more, no fewer"
    );
  });
});

// ── 2. query-plan evidence ─────────────────────────────────────────────────

describe("dependency closure — query-plan evidence", () => {
  async function explain(sql, ...params) {
    const rows = await prisma.$queryRawUnsafe(
      `EXPLAIN (ANALYZE, BUFFERS, COSTS OFF, TIMING OFF) ${sql}`,
      ...params
    );
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  // A race-scoped index only WINS when the target race is a small fraction of
  // the table. With one 350-row race in an otherwise empty database a
  // sequential scan is genuinely cheaper and Postgres is right to choose it —
  // asserting "index" there would be asserting a planner accident. This builds
  // the surrounding corpus that makes race-scoping the correct plan, which is
  // the condition that actually holds in production.
  async function seedDecoyCorpus({ races = 40, perRace = 300 } = {}) {
    const users = [];
    const participants = [];
    const effects = [];
    const decoyRaces = [];
    const started = new Date(Date.now() - 8 * HOUR_MS);
    for (let r = 0; r < races; r++) {
      const raceId = `decoy-r${r}`;
      decoyRaces.push({
        id: raceId,
        name: `Decoy ${r}`,
        targetSteps: 10000,
        status: "ACTIVE",
        startedAt: started,
        endsAt: new Date(Date.now() + 24 * HOUR_MS),
        updatedAt: new Date(),
      });
      for (let i = 0; i < perRace; i++) {
        const userId = `decoy-u${r}-${i}`;
        users.push({ id: userId, appleId: `decoy-a${r}-${i}` });
        participants.push({
          id: `decoy-p${r}-${i}`,
          raceId,
          userId,
          status: i % 5 === 0 ? "INVITED" : "ACCEPTED",
          joinedAt: started,
        });
      }
    }
    await prisma.race.createMany({ data: decoyRaces });
    await prisma.user.createMany({ data: users });
    await prisma.raceParticipant.createMany({ data: participants });
    // Effect rows across the decoy races, in every status the closure read
    // filters on, so the effect-history scan has a real corpus to be selective
    // against.
    const powerups = [];
    for (let r = 0; r < races; r++) {
      for (let i = 0; i < 40; i++) {
        powerups.push({
          id: `decoy-pw${r}-${i}`,
          raceId: `decoy-r${r}`,
          participantId: `decoy-p${r}-${i}`,
          userId: `decoy-u${r}-${i}`,
          type: i % 3 === 0 ? "LEECH" : "RUNNERS_HIGH",
          status: "USED",
          usedAt: new Date(),
        });
        effects.push({
          id: `decoy-e${r}-${i}`,
          powerupId: `decoy-pw${r}-${i}`,
          raceId: `decoy-r${r}`,
          targetParticipantId: `decoy-p${r}-${i}`,
          targetUserId: `decoy-u${r}-${i}`,
          sourceUserId: `decoy-u${r}-${(i + 1) % 40}`,
          type: i % 3 === 0 ? "LEECH" : "RUNNERS_HIGH",
          status: i % 2 === 0 ? "ACTIVE" : "EXPIRED",
          startsAt: started,
          expiresAt: new Date(Date.now() + HOUR_MS),
        });
      }
    }
    await prisma.racePowerup.createMany({ data: powerups });
    await prisma.raceActiveEffect.createMany({ data: effects });
  }

  it("the accepted-member, effect-history and sample-boundary scans are all index-driven at 350 participants", async () => {
    const { raceId } = await seedRaceOfSize(350);
    await seedDecoyCorpus();
    // ANALYZE so the planner is choosing on real statistics rather than on the
    // defaults it assumes for a table it has never seen.
    await prisma.$executeRawUnsafe(
      "ANALYZE race_participants, race_active_effects, step_samples"
    );

    // (a) the accepted-member scan (the fingerprint's `members` CTE).
    const memberPlan = await explain(
      `SELECT DISTINCT participant.user_id FROM race_participants participant
       WHERE participant.race_id = $1 AND participant.status = 'accepted'`,
      raceId
    );
    assert.match(
      memberPlan,
      /Index (Only )?Scan|Bitmap (Heap|Index) Scan/,
      `the accepted-member scan must be race-scoped through an index:\n${memberPlan}`
    );

    // (b) the effect-history scan (ACTIVE + the schema-2 EXPIRED LEECH/HITCHHIKE
    //     rows the closure graph needs).
    const effectPlan = await explain(
      `SELECT id, UPPER(type::text) AS type FROM race_active_effects
       WHERE race_id = $1
         AND (status = 'active_effect'
              OR (status = 'expired_effect'
                  AND UPPER(type::text) IN ('LEECH','HITCHHIKE')))`,
      raceId
    );
    assert.match(
      effectPlan,
      /Index (Only )?Scan|Bitmap (Heap|Index) Scan/,
      `the effect-history scan must be race-scoped through an index:\n${effectPlan}`
    );

    // (c) the per-member next-sample-boundary subselect — the planner's cost
    //     tail. Without `step_samples(user_id, period_end)` this cannot be
    //     answered in sorted order and degrades to scanning every one of a
    //     member's sample rows and aggregating. With it, the aggregate collapses
    //     to a one-row ordered index scan, which is what "Index ... Scan"
    //     plus a tiny row count below proves.
    const boundaryPlan = await explain(
      `SELECT MIN(source.period_end) FROM step_samples source
       WHERE source.user_id = $1 AND source.period_end > $2`,
      "fill350x1-u0",
      new Date(Date.now() - 10 * HOUR_MS)
    );
    assert.match(
      boundaryPlan,
      /step_samples_user_id_period_end_idx/,
      `the sample-boundary subselect must use the additive ordered index:\n${boundaryPlan}`
    );
    assert.doesNotMatch(
      boundaryPlan,
      /Seq Scan on step_samples/,
      `the sample-boundary subselect must never sequentially scan step_samples:\n${boundaryPlan}`
    );
  });
});
