const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  MISMATCH_REASONS,
  PROJECTION_VERSION,
  REQUIRED_COVERAGE_VARIANTS,
  compareRacesTabProjection,
  observedCoverageVariants,
  projectRacesTabPayload,
} = require("../../../src/modules/loadTesting/racesTabOpenProjection");

function corePayload() {
  return {
    contract: "race-list-compact-v1",
    active: [{
      id: "race-active", name: "Active", status: "ACTIVE",
      creator: { displayName: "Creator" }, isCreator: false, participantCount: 4,
      isTeamRace: false, isFavorite: true, favoritedAt: "2026-09-03T00:00:00.000Z",
      myPlacement: 2, myPlacementHidden: false,
      myDisplayPlacement: 3, placementPrivacyActive: true, myStatus: "ACCEPTED",
      maxDurationDays: 9,
      startedAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-10T00:00:00.000Z",
      slotItems: [{ type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
        { type: null, rarity: null, status: "MYSTERY_BOX" }],
      queuedBoxCount: 2, mysteryBoxCount: 1,
      myActiveEffects: [{ type: "PROTEIN_SHAKE" },
        { type: "DETOUR_SIGN", status: "ACTIVE" }],
    }],
    pending: [{
      id: "race-invite", name: "Invite", status: "PENDING",
      creator: { displayName: "Inviter" }, isCreator: false, participantCount: 1,
      isTeamRace: false, isFavorite: false, favoritedAt: null,
      myStatus: "INVITED", myPlacement: null, myPlacementHidden: false,
      createdAt: "2026-09-03T00:00:00.000Z",
      scheduledStartAt: null, scheduledEndAt: null,
      myInviteExpiresAt: "2026-09-10T00:00:00.000Z",
    }],
    completed: [],
    tournaments: [{
      id: "t-live", name: "Bracket", status: "ACTIVE", myStatus: "ACCEPTED",
      isFavorite: true, favoritedAt: "2026-09-03T01:00:00.000Z",
      bracketSize: 4, acceptedCount: 4, currentRound: 1, totalRounds: 2,
      championPrizeCoins: 250, potCoins: 250,
      myIdentity: { displayName: "Runner", animal: "capybara",
        equippedAccessories: [{ slot: "head", assetId: "hat" }] },
      myEliminatedInRound: null, championUserId: null,
      myCurrentMatchRaceId: "match-1",
      myCurrentMatch: { raceId: "match-1", myPlacement: 1,
        myPlacementHidden: false, endsAt: "2026-09-04T00:00:00.000Z",
        queuedBoxCount: 1, mysteryBoxCount: 1,
        slotItems: [{ type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" },
          { type: null, rarity: null, status: "MYSTERY_BOX" }] },
    }],
  };
}

test("v2 projection separates ordinary and tournament-match content without IDs", () => {
  const projected = projectRacesTabPayload({
    core: corePayload(),
    discovery: { publicRaceCount: 7 },
    friends: { contract: "friends-summary-v1", friends: [] },
    friendsShouldRequest: true,
    viewerUserId: "viewer",
  });
  assert.equal(projected.expectedProjectionVersion, PROJECTION_VERSION);
  assert.equal(projected.ordinary.active[0].rowKey, "ordinary.active.0");
  assert.equal(projected.ordinary.active[0].myStatus, "ACCEPTED");
  assert.equal(projected.ordinary.active[0].maxDurationDays, 9);
  assert.deepEqual(projected.ordinary.active[0].placement, {
    value: 2, hidden: false, displayValue: 3, privacyActive: true,
  });
  assert.equal(projected.ordinary.invited[0].rowKey, "ordinary.invited.0");
  assert.equal(projected.ordinaryInventoryByRace[0].rowKey, "ordinary.active.0");
  assert.deepEqual(projected.ordinaryInventoryByRace[0].heldTypedItems,
    [{ type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD" }]);
  assert.equal(projected.ordinaryEffectsByRace[0].positive.PROTEIN_SHAKE, 1);
  assert.equal(projected.ordinaryEffectsByRace[0].negative.DETOUR_SIGN, 1);
  assert.equal(projected.tournaments.active[0].renderState, "live_match");
  assert.equal(projected.tournaments.active[0].hasCurrentMatchRaceId, true);
  assert.equal(projected.tournamentMatchByTournament[0].rowKey, "tournaments.active.0");
  assert.equal(projected.tournamentMatchByTournament[0].placement.value, 1);
  assert.equal(projected.discovery.publicRaceCount, 7);
  assert.deepEqual(projected.friends, { shouldRequest: true, expectedCount: 0,
    expectedContract: "friends-summary-v1" });
  assert.equal(JSON.stringify(projected).includes("race-active"), false);
  assert.equal(JSON.stringify(projected).includes("match-1"), false);
});

test("coverage is derived from observed response predicates rather than fixture labels", () => {
  const projected = projectRacesTabPayload({ core: corePayload(), viewerUserId: "viewer" });
  const variants = observedCoverageVariants(projected);
  for (const variant of ["ordinary_classic_active", "pinned_classic",
    "ordinary_placement_visible", "ordinary_inventory_held_typed",
    "ordinary_inventory_mystery_box", "ordinary_inventory_queued_box",
    "ordinary_effect_positive", "ordinary_effect_negative", "ordinary_invite",
    "pinned_tournament", "tournament_live_match",
    "tournament_match_placement_visible", "tournament_match_inventory_held_typed",
    "tournament_match_inventory_mystery_box", "tournament_match_inventory_queued_box"]) {
    assert.ok(variants.includes(variant), variant);
  }
  assert.equal(variants.includes("ordinary_team_active"), false);
  assert.equal(variants.includes("tournament_between_rounds"), false);
});

test("privacy-aware placement coverage uses the display projection and has Node/k6 parity", () => {
  const rows = [
    { placement: { value: 2, hidden: false, displayValue: 3, privacyActive: true },
      expected: "ordinary_placement_visible" },
    { placement: { value: 2, hidden: false, displayValue: null, privacyActive: true },
      expected: "ordinary_placement_hidden" },
    { placement: { value: 2, hidden: true, displayValue: 3, privacyActive: true },
      expected: "ordinary_placement_hidden" },
  ];
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../../scripts/k6/races-tab-projection.js"), "utf8").replaceAll("export ", "");
  const k6Observed = vm.runInNewContext(`${source}\nobservedCoverageVariants`);
  for (const row of rows) {
    const projection = { ordinary: { active: [{ kind: "classic", isFavorite: false,
      placement: row.placement }] }, tournaments: {}, ordinaryInventoryByRace: [],
    ordinaryEffectsByRace: [], tournamentMatchByTournament: [] };
    const nodeVariants = observedCoverageVariants(projection);
    const k6Variants = [...k6Observed(projection)];
    assert.deepEqual(k6Variants, nodeVariants);
    assert.ok(nodeVariants.includes(row.expected));
    assert.equal(nodeVariants.includes(row.expected === "ordinary_placement_visible"
      ? "ordinary_placement_hidden" : "ordinary_placement_visible"), false);
  }
});

test("measurement mismatch indexes are relative to a nonzero measurement pool offset", () => {
  const source = fs.readFileSync(path.resolve(__dirname,
    "../../../scripts/k6/races-tab-projection.js"), "utf8").replaceAll("export ", "");
  const poolIndex = vm.runInNewContext(`${source}\nmeasurementPoolFixtureIndex`);
  assert.equal(poolIndex(977, 977), 0);
  assert.equal(poolIndex(1026, 977), 49);
  assert.equal(poolIndex(1027, 977), 50);
  assert.equal(poolIndex(10, 20), null);
});

test("projection comparison is additive-field tolerant and returns stable mismatch enums", () => {
  const expected = projectRacesTabPayload({ core: corePayload(),
    discovery: { publicRaceCount: 7 }, friends: { contract: "friends-summary-v1", friends: [] },
    friendsShouldRequest: true });
  const additive = structuredClone(expected);
  additive.ordinary.active[0].futureField = "ignored";
  assert.deepEqual(compareRacesTabProjection(expected, additive), {
    matches: true, mismatchCount: 0, mismatchCounts: {}, samples: [], truncated: false,
  });
  const changed = structuredClone(expected);
  changed.ordinary.active[0].name = "Wrong";
  changed.discovery.publicRaceCount = 8;
  const mismatch = compareRacesTabProjection(expected, changed);
  assert.equal(mismatch.matches, false);
  assert.equal(mismatch.mismatchCounts.ordinary_field, 1);
  assert.equal(mismatch.mismatchCounts.discovery_count, 1);
  assert.ok(mismatch.samples.every((sample) => !JSON.stringify(sample).includes("race-active")));
  assert.ok(Object.isFrozen(MISMATCH_REASONS));
});

test("tournaments use the app's action-first shelves and exclude no reachable state", () => {
  const tournament = (overrides) => ({ name: "T", status: "ACTIVE",
    myStatus: "ACCEPTED", bracketSize: 4, acceptedCount: 4,
    currentRound: 1, totalRounds: 2, ...overrides });
  const projected = projectRacesTabPayload({ viewerUserId: "viewer", core: {
    active: [], pending: [], completed: [], tournaments: [
      tournament({ myStatus: "INVITED" }),
      tournament({ status: "PENDING" }),
      tournament({ myCurrentMatch: { myPlacement: 1, myPlacementHidden: false } }),
      tournament({ myEliminatedInRound: 1 }),
      tournament({ status: "COMPLETED", championUserId: "viewer" }),
      tournament({ status: "COMPLETED", championUserId: "someone-else" }),
      tournament({ myCurrentMatch: null }),
    ],
  } });
  assert.deepEqual(projected.tournaments.invited.map((row) => row.renderState), ["invite"]);
  assert.deepEqual(projected.tournaments.active.map((row) => row.renderState), ["live_match"]);
  assert.deepEqual(projected.tournaments.pending.map((row) => row.renderState),
    ["lobby", "between_rounds"]);
  assert.deepEqual(projected.tournaments.completed.map((row) => row.renderState),
    ["eliminated", "champion", "completed_non_champion"]);
});

test("full-page contract locks all 28 coverage variants", () => {
  assert.equal(REQUIRED_COVERAGE_VARIANTS.length, 28);
  assert.equal(new Set(REQUIRED_COVERAGE_VARIANTS).size, 28);
  for (const required of ["ordinary_team_active", "ordinary_effect_negative",
    "tournament_between_rounds", "tournament_completed_non_champion",
    "tournament_match_inventory_queued_box"]) {
    assert.ok(REQUIRED_COVERAGE_VARIANTS.includes(required));
  }
});
