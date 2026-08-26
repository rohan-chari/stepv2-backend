const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const acorn = require("acorn");

function source(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, "../..", relativePath), "utf8");
}

test("race start takes C0 before the global-event enrollment lock", () => {
  const text = source("src/modules/races/services/commitRaceStart.js");
  const c0 = text.indexOf("acquireRaceWriteFence(tx");
  const globalEvent = text.indexOf("acquireGlobalEnrollmentLock(tx)");
  assert.notEqual(c0, -1);
  assert.notEqual(globalEvent, -1);
  assert.ok(c0 < globalEvent, "required order is C0 then global-event lock");
});

test("all direct race invitation membership mutations enter C0", () => {
  for (const relativePath of [
    "src/modules/races/commands/inviteToRace.js",
    "src/modules/races/commands/respondToRaceInvite.js",
    "src/modules/races/commands/kickRaceParticipant.js",
  ]) {
    const text = source(relativePath);
    assert.match(text, /acquireWriteFence\(tx, raceId\)/, relativePath);
  }
});

test("global-event boundary enqueues take existing-race C0s before global lock", () => {
  const full = source("src/modules/steps/services/globalStepEventEntitlement.js");
  const text = full.slice(
    full.indexOf("async function processDueEntitlementBoundaries"),
    full.indexOf("async function ensureRaceGlobalEventEligibility"),
  );
  const firstC0 = text.indexOf("acquireRaceWriteFences(tx");
  const firstGlobal = text.indexOf("acquireGlobalEnrollmentLock(tx)");
  assert.notEqual(firstC0, -1);
  assert.ok(firstC0 < firstGlobal, "start boundary must take C0 before global");
  const secondC0 = text.indexOf("acquireRaceWriteFences(tx", firstC0 + 1);
  const secondGlobal = text.indexOf(
    "acquireGlobalEnrollmentLock(tx)",
    firstGlobal + 1,
  );
  assert.notEqual(secondC0, -1);
  assert.ok(secondC0 < secondGlobal, "end boundary must take C0 before global");
});

test("new-race participant writers establish the shared C0 row before membership", () => {
  for (const [relativePath, fence, membership] of [
    [
      "src/modules/races/commands/createRace.js",
      "acquireRaceWriteFence(defaultPrisma, race.id)",
      "participantModel.create({",
    ],
    [
      "src/modules/tournaments/services/tournamentRounds.js",
      "acquireRaceWriteFence(tx, race.id)",
      "tx.raceParticipant.create({",
    ],
  ]) {
    const text = source(relativePath);
    const fenceIndex = text.indexOf(fence);
    const membershipIndex = text.indexOf(membership);
    assert.notEqual(fenceIndex, -1, relativePath);
    assert.notEqual(membershipIndex, -1, relativePath);
    assert.ok(fenceIndex < membershipIndex, relativePath);
  }
});

const MEMBERSHIP_WRITER_LOCK_INVENTORY = [
  ["src/modules/races/commands/createRace.js", ["lockFundedExposureUsers", "acquireRaceWriteFence"], "participantModel.create({"],
  ["src/modules/races/commands/inviteToRace.js", ["acquireWriteFence", "lockFundedExposureUsers"], "raceParticipant.createMany"],
  ["src/modules/tournaments/commands/createTournament.js", ["lockFundedExposureUsers"], "participants: {"],
  ["src/modules/tournaments/commands/inviteToTournament.js", ["withTournamentLock", "userIds:"], "tournamentParticipant.create"],
  ["src/modules/tournaments/commands/joinTournamentCore.js", ["withTournamentLock", "resolveUserIds:"], "tournamentParticipant.create"],
  ["src/modules/tournaments/commands/startTournament.js", ["withTournamentLock", "resolveUserIds:"], "runTournamentStart"],
  ["src/modules/tournaments/jobs/tournamentSeedRenewal.js", ["withTournamentLock", "resolveUserIds:"], "runTournamentStart"],
  ["src/modules/tournaments/services/tournamentRounds.js", ["acquireRaceWriteFence"], "raceParticipant.create"],
];

test("explicit membership-writer inventory declares the universal lock prerequisites", () => {
  for (const [relativePath, requiredLocks, mutation] of MEMBERSHIP_WRITER_LOCK_INVENTORY) {
    const text = source(relativePath);
    assert.match(text, new RegExp(mutation.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), relativePath);
    for (const lock of requiredLocks) {
      assert.match(text, new RegExp(lock), `${relativePath}: missing ${lock}`);
    }
  }
});

test("tournament lock helper enforces global -> sorted user guards -> tournament row", () => {
  const text = source("src/modules/tournaments/services/tournamentLock.js");
  const global = text.indexOf("acquireGlobalEnrollmentLock(tx)");
  const users = text.indexOf("lockFundedExposureUsers(tx");
  const row = text.indexOf("lockCompetitionRows(tx");
  assert.ok(global >= 0 && users > global && row > users);
});

test("tournament advancement guards every surviving user before the tournament row and revalidates", () => {
  const text = source("src/modules/tournaments/commands/advanceTournament.js");
  const discovered = text.indexOf("discoveredAdvancementUserIds");
  const users = text.indexOf("lockFundedExposureUsersFn(tx");
  const row = text.indexOf('SELECT id FROM "tournaments"');
  const revalidated = text.indexOf("lockedAdvancementParticipants");
  const roundCreation = text.indexOf("createRoundRaces({");
  assert.ok(discovered >= 0, "advancement must discover all surviving users");
  assert.ok(users > discovered, "sorted user guards follow discovery");
  assert.ok(row > users, "tournament row lock follows user guards");
  assert.ok(revalidated > row, "membership is revalidated after the tournament row lock");
  assert.ok(roundCreation > revalidated, "round creation follows locked revalidation");
});

// Independent AST inventory: every direct participant-table mutation and every
// command/service participantModel mutation is pinned here. Adding a writer,
// moving one to a new file, or changing its mutation kind fails until the
// writer is deliberately classified in the lock audit above (or documented as
// a scalar-only projection update). This is intentionally separate from the
// production helpers so the guard cannot satisfy itself.
const EXPECTED_PARTICIPANT_MUTATIONS = {
  "src/modules/loadTesting/fixtures.js": ["raceParticipant.create", "raceParticipant.deleteMany"],
  "src/modules/notifications/dailyMover.js": ["participantModel.update"],
  "src/modules/powerups/commands/openMysteryBox.js": ["participantModel.update"],
  "src/modules/powerups/commands/rollPowerup.js": ["raceParticipant.update", "raceParticipant.update"],
  "src/modules/races/commands/autoEnrollNewUser.js": ["raceParticipant.create"],
  "src/modules/races/commands/autoJoinFeaturedRaces.js": ["raceParticipant.createMany"],
  "src/modules/races/commands/cancelRace.js": ["participantModel.update"],
  "src/modules/races/commands/completeRace.js": ["participantModel.update", "raceParticipant.updateMany", "tournamentParticipant.update", "tournamentParticipant.update"],
  "src/modules/races/commands/createRace.js": ["participantModel.create"],
  "src/modules/races/commands/forfeitRace.js": ["raceParticipant.updateMany"],
  "src/modules/races/commands/inviteToRace.js": ["participantModel.createMany", "raceParticipant.createMany"],
  "src/modules/races/commands/joinRaceCore.js": ["participantModel.create", "raceParticipant.create"],
  "src/modules/races/commands/kickRaceParticipant.js": ["participantModel.delete", "raceParticipant.delete"],
  "src/modules/races/commands/leaveRace.js": ["participantModel.delete", "raceParticipant.delete"],
  "src/modules/races/commands/markRaceResultsSeen.js": ["raceParticipant.updateMany", "raceParticipant.updateMany"],
  "src/modules/races/commands/respondToRaceInvite.js": ["participantModel.update", "participantModel.updateLiveInvite", "raceParticipant.updateMany", "raceParticipant.updateMany"],
  "src/modules/races/commands/setRaceChatMute.js": ["raceParticipant.update", "raceParticipant.update"],
  "src/modules/races/commands/setRacePlacementMute.js": ["raceParticipant.update"],
  "src/modules/races/commands/startRace.js": ["participantModel.update"],
  "src/modules/races/commands/switchRaceTeam.js": ["participantModel.update"],
  "src/modules/races/jobs/placementRecompute.js": ["participantModel.update", "participantModel.update", "participantModel.update", "participantModel.update"],
  "src/modules/races/jobs/raceAdminCommandRunner.js": ["raceParticipant.create", "raceParticipant.update"],
  "src/modules/races/jobs/raceExpiry.js": ["raceParticipant.update", "raceParticipant.update"],
  "src/modules/races/jobs/raceResolutionQueueV2.js": ["raceParticipant.update"],
  "src/modules/races/jobs/seededRaceRenewal.js": ["raceParticipant.deleteMany", "raceParticipant.deleteMany", "raceParticipant.update", "raceParticipant.updateMany", "raceParticipant.updateMany"],
  "src/modules/races/models/raceParticipant.js": ["raceParticipant.create", "raceParticipant.createMany", "raceParticipant.delete", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.update", "raceParticipant.updateMany", "raceParticipant.updateMany"],
  "src/modules/races/services/commitRaceStart.js": ["raceParticipant.update"],
  "src/modules/races/services/fundedExposure.js": ["raceParticipant.update", "raceParticipant.updateMany", "tournamentParticipant.update", "tournamentParticipant.updateMany"],
  "src/modules/races/services/highMultiplierAlert.js": ["raceParticipant.updateMany", "raceParticipant.updateMany"],
  "src/modules/races/services/legacyBuyInRemediation.js": ["raceParticipant.update", "raceParticipant.updateMany"],
  "src/modules/races/services/racePowerupStateSync.js": ["raceParticipant.update", "raceParticipant.update"],
  "src/modules/races/services/raceResolutionDeliveryIntents.js": ["raceParticipant.updateMany"],
  "src/modules/races/services/seededRaceBuckets.js": ["raceParticipant.createMany", "raceParticipant.delete"],
  "src/modules/tournaments/commands/cancelTournament.js": ["tournamentParticipant.update"],
  "src/modules/tournaments/commands/createTournament.js": ["nested.participants.create", "tournamentParticipant.createMany"],
  "src/modules/tournaments/commands/forfeitTournament.js": ["raceParticipant.update"],
  "src/modules/tournaments/commands/inviteToTournament.js": ["tournamentParticipant.create", "tournamentParticipant.update"],
  "src/modules/tournaments/commands/joinTournamentCore.js": ["tournamentParticipant.create", "tournamentParticipant.update", "tournamentParticipant.update"],
  "src/modules/tournaments/services/tournamentParticipants.js": ["tournamentParticipant.update"],
  "src/modules/tournaments/services/tournamentRounds.js": ["raceParticipant.create"],
  "src/modules/tournaments/services/tournamentStart.js": ["tournamentParticipant.update", "tournamentParticipant.update"],
  "src/modules/users/commands/deleteUserAccount.js": ["raceParticipant.delete", "raceParticipant.delete", "raceParticipant.update", "tournamentParticipant.delete", "tournamentParticipant.delete", "tournamentParticipant.update"],
};

function jsFiles(root) {
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...jsFiles(full));
    else if (entry.name.endsWith(".js")) result.push(full);
  }
  return result;
}

const PARTICIPANT_MUTATION_METHODS = new Set([
  "create",
  "createMany",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
  "updateLiveInvite",
]);

function participantMutationsInText(text) {
  const ast = acorn.parse(text, {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const found = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.type === "CallExpression" && node.callee?.type === "MemberExpression") {
      const method = node.callee.computed
        ? node.callee.property.value
        : node.callee.property.name;
      const object = node.callee.object;
      let delegate = null;
      if (object?.type === "MemberExpression") {
        delegate = object.computed ? object.property.value : object.property.name;
      } else if (object?.type === "Identifier" && object.name === "participantModel") {
        delegate = object.name;
      }
      if (
        ["raceParticipant", "tournamentParticipant", "participantModel"].includes(delegate) &&
        PARTICIPANT_MUTATION_METHODS.has(method)
      ) {
        found.push(`${delegate}.${method}`);
      }
    }
    if (node.type === "Property") {
      const relation = node.computed
        ? node.key?.value
        : node.key?.name || node.key?.value;
      if (relation === "participants" && node.value?.type === "ObjectExpression") {
        for (const property of node.value.properties) {
          const method = property.computed
            ? property.key?.value
            : property.key?.name || property.key?.value;
          if (PARTICIPANT_MUTATION_METHODS.has(method)) {
            found.push(`nested.participants.${method}`);
          }
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value?.type) walk(value);
    }
  }
  walk(ast);
  return found.sort();
}

function participantMutations(relativePath) {
  return participantMutationsInText(source(relativePath));
}

test("AST inventory detects direct delegates, nested relation writes, and non-race directories", () => {
  const fixture = `
    tx.raceParticipant.update({ where: { id: "p" }, data: { status: "ACCEPTED" } });
    tx.tournament.create({ data: { participants: { create: { userId: "u" } } } });
  `;
  assert.deepEqual(participantMutationsInText(fixture), [
    "nested.participants.create",
    "raceParticipant.update",
  ]);
  assert.deepEqual(
    participantMutations("src/modules/powerups/commands/rollPowerup.js"),
    ["raceParticipant.update", "raceParticipant.update"],
  );
});

test("AST inventory exhaustively pins every race/tournament participant mutation", () => {
  const root = path.resolve(__dirname, "../../src");
  const discovered = {};
  for (const full of jsFiles(root)) {
    const relative = path.relative(path.resolve(__dirname, "../.."), full);
    const mutations = participantMutations(relative);
    if (mutations.length > 0) discovered[relative] = mutations;
  }
  const expected = Object.fromEntries(
    Object.entries(EXPECTED_PARTICIPANT_MUTATIONS).map(([file, values]) => [
      file,
      [...values].sort(),
    ]),
  );
  assert.deepEqual(discovered, expected);
});

const EXPECTED_INDIRECT_MEMBERSHIP_WRITER_CALLS = {
  "src/modules/tournaments/commands/advanceTournament.js": ["createRoundRaces"],
  "src/modules/tournaments/commands/joinTournamentCore.js": ["runTournamentStart"],
  "src/modules/tournaments/commands/startTournament.js": ["runTournamentStart"],
  "src/modules/tournaments/jobs/tournamentSeedRenewal.js": ["runTournamentStart"],
  "src/modules/tournaments/services/tournamentStart.js": ["createRoundRaces"],
};

function indirectMembershipWriterCalls(relativePath) {
  const ast = acorn.parse(source(relativePath), {
    ecmaVersion: "latest",
    sourceType: "script",
  });
  const found = [];
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      ["createRoundRaces", "runTournamentStart"].includes(node.callee.name)
    ) {
      found.push(node.callee.name);
    }
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else if (value?.type) walk(value);
    }
  }
  walk(ast);
  return found.sort();
}

test("AST inventory pins indirect participant-writer call sites and callers", () => {
  const root = path.resolve(__dirname, "../../src");
  const discovered = {};
  for (const full of jsFiles(root)) {
    const relative = path.relative(path.resolve(__dirname, "../.."), full);
    const calls = indirectMembershipWriterCalls(relative);
    if (calls.length > 0) discovered[relative] = calls;
  }
  const expected = Object.fromEntries(
    Object.entries(EXPECTED_INDIRECT_MEMBERSHIP_WRITER_CALLS).map(([file, calls]) => [
      file,
      [...calls].sort(),
    ]),
  );
  assert.deepEqual(discovered, expected);
});

const SERIALIZED_MEMBERSHIP_LOCK_OWNERS = {
  "src/modules/races/commands/autoEnrollNewUser.js": ["src/modules/races/commands/autoEnrollNewUser.js", ["acquireWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers"]],
  "src/modules/races/commands/autoJoinFeaturedRaces.js": ["src/modules/races/commands/autoJoinFeaturedRaces.js", ["acquireWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers"]],
  "src/modules/races/commands/completeRace.js": ["src/modules/races/commands/completeRace.js", ["acquireRaceWriteFence", "lockFundedExposureUsers", "FOR UPDATE"]],
  "src/modules/races/commands/createRace.js": ["src/modules/races/commands/createRace.js", ["lockFundedExposureUsers", "acquireRaceWriteFence"]],
  "src/modules/races/commands/forfeitRace.js": ["src/modules/races/commands/forfeitRace.js", ["acquireWriteFence", "lockFundedExposureUsers"]],
  "src/modules/races/commands/inviteToRace.js": ["src/modules/races/commands/inviteToRace.js", ["acquireWriteFence", "lockFundedExposureUsers"]],
  "src/modules/races/commands/joinRaceCore.js": ["src/modules/races/services/raceJoinLock.js", ["acquireFundedMembershipRaceWriteFences", "lockFundedExposureUsers", "lockCompetitionRows"]],
  "src/modules/races/commands/kickRaceParticipant.js": ["src/modules/races/commands/kickRaceParticipant.js", ["acquireWriteFence", "lockFundedExposureUsers"]],
  "src/modules/races/commands/leaveRace.js": ["src/modules/races/commands/leaveRace.js", ["acquireWriteFence", "lockFundedExposureUsers"]],
  "src/modules/races/commands/respondToRaceInvite.js": ["src/modules/races/commands/respondToRaceInvite.js", ["acquireWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers"]],
  "src/modules/races/jobs/raceAdminCommandRunner.js": ["src/modules/races/jobs/raceAdminCommandRunner.js", ["acquireRaceWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers", "lockCompetitionRows"]],
  "src/modules/races/jobs/seededRaceRenewal.js": ["src/modules/races/jobs/seededRaceRenewal.js", ["acquireRaceWriteFence", "lockFundedExposureUsers"]],
  "src/modules/races/services/commitRaceStart.js": ["src/modules/races/services/commitRaceStart.js", ["acquireRaceWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers"]],
  "src/modules/races/services/seededRaceBuckets.js": ["src/modules/races/services/seededRaceBuckets.js", ["acquireRaceWriteFence", "lockFundedExposureUsers"]],
  "src/modules/tournaments/commands/createTournament.js": ["src/modules/tournaments/commands/createTournament.js", ["lockFundedExposureUsers"]],
  "src/modules/tournaments/commands/forfeitTournament.js": ["src/modules/tournaments/commands/forfeitTournament.js", ["acquireRaceWriteFence", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers", "lockCompetitionRows"]],
  "src/modules/tournaments/commands/inviteToTournament.js": ["src/modules/tournaments/commands/inviteToTournament.js", ["withTournamentLock", "userIds:"]],
  "src/modules/tournaments/commands/joinTournamentCore.js": ["src/modules/tournaments/commands/joinTournamentCore.js", ["withTournamentLock", "resolveUserIds:"]],
  "src/modules/tournaments/services/tournamentParticipants.js": ["src/modules/tournaments/services/tournamentLock.js", ["lockFundedExposureUsers", "lockCompetitionRows"]],
  "src/modules/tournaments/services/tournamentRounds.js": ["src/modules/tournaments/services/tournamentRounds.js", ["acquireRaceWriteFence"]],
  "src/modules/tournaments/services/tournamentStart.js": ["src/modules/tournaments/commands/startTournament.js", ["withTournamentLock", "resolveUserIds:"]],
  "src/modules/users/commands/deleteUserAccount.js": ["src/modules/users/commands/deleteUserAccount.js", ["acquireRaceWriteFences", "acquireGlobalEnrollmentLock", "lockFundedExposureUsers", "lockCompetitionRows"]],
};

const INDIRECT_MEMBERSHIP_LOCK_OWNERS = {
  "src/modules/tournaments/commands/advanceTournament.js": [
    "src/modules/tournaments/commands/advanceTournament.js",
    ["acquireGlobalEnrollmentLock", "lockFundedExposureUsers", 'SELECT id FROM "tournaments"', "createRoundRaces"],
  ],
  "src/modules/tournaments/commands/joinTournamentCore.js": [
    "src/modules/tournaments/commands/joinTournamentCore.js",
    ["withTournamentLock", "resolveUserIds:", "runTournamentStart"],
  ],
  "src/modules/tournaments/commands/startTournament.js": [
    "src/modules/tournaments/commands/startTournament.js",
    ["withTournamentLock", "resolveUserIds:", "runTournamentStart"],
  ],
  "src/modules/tournaments/jobs/tournamentSeedRenewal.js": [
    "src/modules/tournaments/jobs/tournamentSeedRenewal.js",
    ["withTournamentLock", "resolveUserIds:", "runTournamentStart"],
  ],
  "src/modules/tournaments/services/tournamentStart.js": [
    "src/modules/tournaments/services/tournamentRounds.js",
    ["acquireRaceWriteFence", "raceParticipant.create"],
  ],
};

const NON_MEMBERSHIP_PARTICIPANT_WRITERS = new Set([
  "src/modules/loadTesting/fixtures.js",
  "src/modules/notifications/dailyMover.js",
  "src/modules/powerups/commands/openMysteryBox.js",
  "src/modules/powerups/commands/rollPowerup.js",
  "src/modules/races/commands/cancelRace.js",
  "src/modules/races/commands/markRaceResultsSeen.js",
  "src/modules/races/commands/setRaceChatMute.js",
  "src/modules/races/commands/setRacePlacementMute.js",
  "src/modules/races/commands/startRace.js",
  "src/modules/races/commands/switchRaceTeam.js",
  "src/modules/races/jobs/placementRecompute.js",
  "src/modules/races/jobs/raceExpiry.js",
  "src/modules/races/jobs/raceResolutionQueueV2.js",
  "src/modules/races/models/raceParticipant.js",
  "src/modules/races/services/fundedExposure.js",
  "src/modules/races/services/highMultiplierAlert.js",
  "src/modules/races/services/legacyBuyInRemediation.js",
  "src/modules/races/services/racePowerupStateSync.js",
  "src/modules/races/services/raceResolutionDeliveryIntents.js",
  "src/modules/tournaments/commands/cancelTournament.js",
]);

test("worker-owned box scalar writes require caller tx after advisory locks and before job success", () => {
  const worker = source("src/modules/races/jobs/raceResolutionQueueV2.js");
  const advisory = worker.indexOf("pg_advisory_xact_lock");
  const boxSync = worker.indexOf("advisoryLockHeld: true");
  const success = worker.indexOf('"recordSuccess"', boxSync);
  assert.ok(advisory >= 0 && boxSync > advisory && success > boxSync);
  const service = source("src/modules/races/services/racePowerupStateSync.js");
  assert.match(service, /tx = null/);
  assert.match(service, /await tx\.raceParticipant\.update/);
});

test("every inventoried mutation is explicitly classified and membership writers name their lock owner", () => {
  const classified = new Set([
    ...Object.keys(SERIALIZED_MEMBERSHIP_LOCK_OWNERS),
    ...NON_MEMBERSHIP_PARTICIPANT_WRITERS,
  ]);
  assert.deepEqual(
    [...classified].sort(),
    Object.keys(EXPECTED_PARTICIPANT_MUTATIONS).sort(),
  );
  for (const [writer, [owner, tokens]] of Object.entries(SERIALIZED_MEMBERSHIP_LOCK_OWNERS)) {
    const text = source(owner);
    for (const token of tokens) {
      assert.match(text, new RegExp(token), `${writer}: ${owner} missing ${token}`);
    }
  }
  assert.deepEqual(
    Object.keys(INDIRECT_MEMBERSHIP_LOCK_OWNERS).sort(),
    Object.keys(EXPECTED_INDIRECT_MEMBERSHIP_WRITER_CALLS).sort(),
  );
  for (const [caller, [owner, tokens]] of Object.entries(INDIRECT_MEMBERSHIP_LOCK_OWNERS)) {
    const text = source(owner);
    for (const token of tokens) {
      assert.match(text, new RegExp(token), `${caller}: ${owner} missing ${token}`);
    }
  }
});
