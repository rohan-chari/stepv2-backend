const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");

const { buildGetRaceProgress } = require("../../src/modules/races/queries/getRaceProgress");
const {
  buildResolveRaceState,
} = require("../../src/modules/races/services/raceStateResolution");
const { computeBoxEffectiveSteps } = require("../../src/modules/powerups/boxSteps");

// ---------------------------------------------------------------------------
// HITCHHIKE end-to-end scoring (§7.3) and the LIVE/SETTLEMENT PARITY GUARD.
//
// The final scoring assembly is DUPLICATED across getRaceProgress (live display)
// and raceStateResolution/raceExpiry (background resolution + settlement). A
// shared calculation utility is NOT sufficient — the additive Hitchhike term has
// to be inserted at EVERY assembly site, into preLeechTotal BEFORE
// applyLeechTransfers runs. Adding it to one site only produces a divergence
// that surfaces as the score changing at race end.
//
// This suite guards that two ways: a real both-paths total comparison, and a
// structural check that every site calls applyHitchhikeCopies inside its
// applyLeechTransfers call.
// ---------------------------------------------------------------------------

const RACE_START = new Date("2026-07-20T00:00:00Z");
const T0 = new Date("2026-07-20T12:00:00Z");
const T1 = new Date("2026-07-20T13:00:00Z");
const NOW = new Date("2026-07-20T15:00:00Z"); // later hour => [T0,T1] closed

function participant(id, userId, name, overrides = {}) {
  return {
    id,
    userId,
    status: "ACCEPTED",
    totalSteps: 0,
    bonusSteps: 0,
    maxBonusSteps: 0,
    powerupSlots: 3,
    nextBoxAtSteps: 0,
    finishedAt: null,
    forfeitedAt: null,
    joinedAt: RACE_START,
    team: null,
    placement: null,
    user: { displayName: name, profilePhotoUrl: null, accessories: [] },
    ...overrides,
  };
}

function hitchhike(id, sourceUserId, target, overrides = {}) {
  return {
    id,
    raceId: "race-1",
    type: "HITCHHIKE",
    status: "ACTIVE",
    startsAt: T0,
    expiresAt: T1,
    sourceUserId,
    targetUserId: target.userId,
    targetParticipantId: target.id,
    metadata: { copyRatio: 1, scoringVersion: 1 },
    ...overrides,
  };
}

function leech(id, sourceUserId, victim, overrides = {}) {
  return {
    id,
    raceId: "race-1",
    type: "LEECH",
    status: "ACTIVE",
    startsAt: T0,
    expiresAt: T1,
    sourceUserId,
    targetUserId: victim.userId,
    targetParticipantId: victim.id,
    metadata: { ratio: 2, scoringVersion: 2 },
    ...overrides,
  };
}

// A whole-race fixture. `dailySteps` is each user's raw walked total for the day;
// `windowSteps` is what they walked inside [T0, T1] (used by the effect windows).
function makeFixture({ participants, effects, dailySteps, windowSteps }) {
  const written = new Map();

  const race = {
    id: "race-1",
    status: "ACTIVE",
    powerupsEnabled: true,
    powerupStepInterval: null,
    startedAt: RACE_START,
    endsAt: null,
    timezone: "UTC",
    maxDurationDays: 1,
    targetSteps: 100000,
    isTeamRace: false,
    participants,
  };

  const stepSampleModel = {
    async sumStepsInWindow(userId, start, end) {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      if (e <= s) return 0;
      // Whole-day reads (the baseAdjusted pass) return the daily total.
      if (s <= RACE_START.getTime() && e >= NOW.getTime()) {
        return dailySteps[userId] || 0;
      }
      // Effect-window reads: prorate the user's [T0,T1] walking.
      const ws = T0.getTime();
      const we = T1.getTime();
      const os = Math.max(ws, s);
      const oe = Math.min(we, e);
      if (oe <= os) return 0;
      return Math.round(
        (windowSteps[userId] || 0) * ((oe - os) / (we - ws))
      );
    },
    async findByUserIdAndTimeRange() {
      return [];
    },
  };

  const raceActiveEffectModel = {
    async findEffectsForRaceByType(_raceId, participantId, type) {
      return effects.filter(
        (e) => e.targetParticipantId === participantId && e.type === type
      );
    },
    async findEffectsForRaceByTypes(_raceId, participantId, types) {
      const byType = {};
      for (const t of types) byType[t] = [];
      for (const e of effects) {
        if (e.targetParticipantId !== participantId) continue;
        if (!types.includes(e.type)) continue;
        byType[e.type].push(e);
      }
      return byType;
    },
    async findRaceEffectsByType(_raceId, type) {
      return effects.filter((e) => e.type === type);
    },
    async findActiveForParticipant() {
      return [];
    },
    async findActiveForRace() {
      return effects;
    },
    async update() {},
  };

  return {
    written,
    race,
    stepSampleModel,
    raceActiveEffectModel,
    deps: {
      Race: {
        async findById() {
          return race;
        },
        async findActiveForUser() {
          return [race];
        },
      },
      RaceParticipant: {
        async updateTotalSteps(id, total) {
          written.set(id, total);
        },
        async findById(id) {
          return participants.find((p) => p.id === id);
        },
      },
      Steps: {
        async findByUserIdAndDate() {
          return null;
        },
        async findByUserIdAndDateRange() {
          return [];
        },
      },
      StepSample: stepSampleModel,
      RaceActiveEffect: raceActiveEffectModel,
      RacePowerup: {
        async findSlotPowerups() {
          return [];
        },
        async countQueuedByParticipant() {
          return 0;
        },
      },
      RacePowerupEvent: {
        async create() {},
        async findMany() {
          return [];
        },
      },
      GlobalStepEvent: {
        async findActiveInRange() {
          return [];
        },
      },
      completeRace: async () => {},
      expireEffects: async () => {},
      syncRacePowerupState: async () => ({}),
      now: () => NOW,
    },
  };
}

// Run BOTH assembly sites over the same fixture and return the totals each
// persisted, keyed by participant id.
async function runBothPaths(config) {
  const live = makeFixture(config);
  const getRaceProgress = buildGetRaceProgress(live.deps);
  await getRaceProgress(config.viewerUserId, "race-1", "UTC");

  const settle = makeFixture(config);
  const resolveRaceState = buildResolveRaceState(settle.deps);
  await resolveRaceState({ raceId: "race-1", timeZone: "UTC" });

  return { live: live.written, settlement: settle.written };
}

test("a hitchhike copies the TARGET's raw steps into the CASTER's total, leaving the target untouched", async () => {
  const caster = participant("rp-1", "u-caster", "Alice");
  const target = participant("rp-2", "u-target", "Bob");
  const { live, settlement } = await runBothPaths({
    viewerUserId: "u-caster",
    participants: [caster, target],
    effects: [hitchhike("hh-1", "u-caster", target)],
    dailySteps: { "u-caster": 5000, "u-target": 9000 },
    windowSteps: { "u-caster": 0, "u-target": 4000 },
  });

  assert.equal(live.get("rp-1"), 9000, "5000 walked + 4000 copied");
  assert.equal(live.get("rp-2"), 9000, "the target loses NOTHING");
  assert.equal(
    settlement.get("rp-1"),
    live.get("rp-1"),
    "PARITY: settlement total equals the live total"
  );
  assert.equal(settlement.get("rp-2"), live.get("rp-2"));
});

test("PARITY: hitchhike x leech ordering agrees at both assembly sites", async () => {
  // A hitchhikes B (copies 4000 of B's raw steps) while C leeches A.
  // A's pre-leech total must INCLUDE the copy before the drain resolves, so C
  // drains from 5000 + 4000 = 9000, not from 5000.
  const a = participant("rp-a", "u-a", "Alice");
  const b = participant("rp-b", "u-b", "Bob");
  const c = participant("rp-c", "u-c", "Carol");

  const { live, settlement } = await runBothPaths({
    viewerUserId: "u-a",
    participants: [a, b, c],
    effects: [hitchhike("hh-1", "u-a", b), leech("l-1", "u-c", a)],
    dailySteps: { "u-a": 5000, "u-b": 9000, "u-c": 2000 },
    // C walks 20000 in the window => earns floor(20000/2) = 10000 of drain,
    // which EXCEEDS A's pre-leech total unless the copy landed first.
    windowSteps: { "u-a": 0, "u-b": 4000, "u-c": 20000 },
  });

  assert.equal(
    live.get("rp-a"),
    0,
    "A is drained to the floor; the copy funded the drain rather than being protected"
  );
  assert.equal(
    live.get("rp-c"),
    2000 + 9000,
    "C is credited exactly what was drained (9000 = 5000 walked + 4000 copied) — proving the copy entered preLeechTotal BEFORE applyLeechTransfers"
  );
  assert.equal(live.get("rp-b"), 9000, "B is untouched by the hitchhike");

  for (const id of ["rp-a", "rp-b", "rp-c"]) {
    assert.equal(
      settlement.get(id),
      live.get(id),
      `PARITY: live and settlement disagree for ${id} — the Hitchhike term was inserted at only one assembly site`
    );
  }
});

test("copies stop at the target's forfeit; steps walked after they exit are never copied", async () => {
  const caster = participant("rp-1", "u-caster", "Alice");
  const target = participant("rp-2", "u-target", "Bob", {
    forfeitedAt: new Date("2026-07-20T12:15:00Z"),
    totalSteps: 7777,
  });
  const { live, settlement } = await runBothPaths({
    viewerUserId: "u-caster",
    participants: [caster, target],
    effects: [hitchhike("hh-1", "u-caster", target)],
    dailySteps: { "u-caster": 5000, "u-target": 9000 },
    windowSteps: { "u-caster": 0, "u-target": 4000 },
  });

  assert.equal(
    live.get("rp-1"),
    6000,
    "only the first quarter of the window (1000 steps) is copied"
  );
  assert.equal(settlement.get("rp-1"), live.get("rp-1"), "PARITY");
});

test("a hitchhike NEVER advances the caster's mystery-box progress", async () => {
  // Box progress is max(0, baseAdjusted) + bonus high-water. The copy is added at
  // the preLeechTotal ASSEMBLY and never folded into baseAdjusted, so this is
  // satisfied structurally.
  const withoutCopy = computeBoxEffectiveSteps({
    baseAdjusted: 5000,
    bonusSteps: 0,
    maxBonusSteps: 0,
  });
  const caster = participant("rp-1", "u-caster", "Alice");
  const target = participant("rp-2", "u-target", "Bob");
  const { live } = await runBothPaths({
    viewerUserId: "u-caster",
    participants: [caster, target],
    effects: [hitchhike("hh-1", "u-caster", target)],
    dailySteps: { "u-caster": 5000, "u-target": 9000 },
    windowSteps: { "u-caster": 0, "u-target": 4000 },
  });

  assert.equal(live.get("rp-1"), 9000, "the race score DOES include the copy");
  assert.equal(
    computeBoxEffectiveSteps({
      baseAdjusted: 5000,
      bonusSteps: 0,
      maxBonusSteps: 0,
    }),
    withoutCopy,
    "box progress is unchanged by an active link"
  );
  assert.equal(withoutCopy, 5000);
});

test("repeated reads never double-credit the caster (recalculation is deterministic)", async () => {
  const config = {
    viewerUserId: "u-caster",
    participants: [
      participant("rp-1", "u-caster", "Alice"),
      participant("rp-2", "u-target", "Bob"),
    ],
    effects: [hitchhike("hh-1", "u-caster", participant("rp-2", "u-target", "Bob"))],
    dailySteps: { "u-caster": 5000, "u-target": 9000 },
    windowSteps: { "u-caster": 0, "u-target": 4000 },
  };
  const fixture = makeFixture(config);
  const getRaceProgress = buildGetRaceProgress(fixture.deps);
  await getRaceProgress("u-caster", "race-1", "UTC");
  const first = fixture.written.get("rp-1");
  await getRaceProgress("u-caster", "race-1", "UTC");
  await getRaceProgress("u-caster", "race-1", "UTC");
  assert.equal(fixture.written.get("rp-1"), first, "no incremental accumulation");
  assert.equal(first, 9000);
});

// Strip comments so a mention of applyLeechTransfers in prose is never mistaken
// for a call site (and so a commented-out call is never counted as one).
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// Every .js file under src/ that CALLS applyLeechTransfers. Discovered by
// walking the tree — never hardcoded. A hardcoded list can only check the sites
// whoever wrote it already remembered, which is precisely the failure mode this
// guard exists to catch.
function discoverLeechAssemblySites() {
  const srcRoot = path.join(__dirname, "..", "..", "src");
  const EXCLUDED = new Set([
    // Defines applyLeechTransfers; not an assembly site.
    path.join(srcRoot, "modules", "powerups", "leechTransfers.js"),
    // Defines applyHitchhikeCopies; not an assembly site.
    path.join(srcRoot, "utils", "hitchhikeCopies.js"),
  ]);

  const sites = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      if (EXCLUDED.has(full)) continue;
      const code = stripComments(fs.readFileSync(full, "utf8"));
      if (/applyLeechTransfers\s*\(/.test(code)) {
        sites.push({ file: path.relative(path.join(srcRoot, ".."), full), code });
      }
    }
  };
  walk(srcRoot);
  return sites;
}

test("STRUCTURAL PARITY GUARD: EVERY discovered scoring-assembly site inserts the hitchhike term inside its leech resolution", () => {
  // A shared computation utility does not by itself prevent divergence — the
  // additive term has to be INSERTED at each duplicated assembly, before the
  // leech resolution. Sites are DISCOVERED, so a future assembly site (or one
  // this batch's author forgot) is covered automatically.
  const sites = discoverLeechAssemblySites();

  assert.ok(
    sites.length >= 6,
    `expected to discover at least the 6 known assembly sites, found ${sites.length}: ${sites
      .map((s) => s.file)
      .join(", ")}`
  );

  const missing = sites
    .filter(
      (s) => !/applyLeechTransfers\(\s*\n?\s*applyHitchhikeCopies\(/.test(s.code)
    )
    .map((s) => s.file);

  assert.deepEqual(
    missing,
    [],
    `these sites resolve leeches WITHOUT inserting the hitchhike term — the copy would be missing from the total they compute:\n  ${missing.join(
      "\n  "
    )}`
  );
});
