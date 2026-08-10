const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOpenMysteryBoxBatch,
} = require("../../src/modules/powerups/commands/openMysteryBoxBatch");

// ---------------------------------------------------------------------------
// "Open All Boxes" batch command (Item 1). Opens the explicit slot boxes the
// client passes AND — when includeQueued is set — materializes + opens the
// user's QUEUED overflow boxes (server owns their identity). Guarantees:
//   * only ever opens the caller's own boxes,
//   * enforces a maxCount cap (hard max 20),
//   * idempotent — a re-sent already-opened id returns its type/rarity,
//   * returns remainingQueuedBoxCount + powerupSlots.
// A fake openMysteryBox is injected so we assert the batch orchestration only.
// ---------------------------------------------------------------------------

function makeDeps({ rows, participant, openImpl } = {}) {
  const store = new Map(rows.map((r) => [r.id, { ...r }]));
  const updates = [];
  const opened = [];

  const openMysteryBox = openImpl || (async ({ powerupId }) => {
    const row = store.get(powerupId);
    // Simulate a normal open: MYSTERY_BOX -> HELD with a rolled type.
    row.status = "HELD";
    row.type = "PROTEIN_SHAKE";
    row.rarity = "COMMON";
    opened.push(powerupId);
    return { id: powerupId, type: "PROTEIN_SHAKE", rarity: "COMMON", autoActivated: false };
  });

  const deps = {
    RacePowerup: {
      async findById(id) { return store.has(id) ? { ...store.get(id) } : null; },
      async update(id, fields) { updates.push({ id, fields }); Object.assign(store.get(id), fields); },
      async findQueuedByParticipant(participantId) {
        return [...store.values()].filter((r) => r.participantId === participantId && r.status === "QUEUED");
      },
      async countQueuedByParticipant(participantId) {
        return [...store.values()].filter((r) => r.participantId === participantId && r.status === "QUEUED").length;
      },
    },
    RaceParticipant: {
      async findByRaceAndUser() { return participant; },
    },
    openMysteryBox,
  };
  return { deps, store, updates, opened };
}

const PARTICIPANT = { id: "rp-1", userId: "user-1", powerupSlots: 3 };

test("opens the requested slot boxes and reports powerupSlots", async () => {
  const rows = [
    { id: "b1", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "MYSTERY_BOX" },
    { id: "b2", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "MYSTERY_BOX" },
  ];
  const { deps, opened } = makeDeps({ rows, participant: PARTICIPANT });
  const batch = buildOpenMysteryBoxBatch(deps);

  const result = await batch({ userId: "user-1", raceId: "race-1", powerupIds: ["b1", "b2"], displayName: "Alice" });

  assert.deepEqual(opened.sort(), ["b1", "b2"]);
  assert.equal(result.results.length, 2);
  assert.ok(result.results.every((r) => r.queued === false && r.type === "PROTEIN_SHAKE"));
  assert.equal(result.powerupSlots, 3);
  assert.equal(result.remainingQueuedBoxCount, 0);
});

test("never opens another user's boxes", async () => {
  const rows = [
    { id: "mine", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "MYSTERY_BOX" },
    { id: "theirs", raceId: "race-1", userId: "user-2", participantId: "rp-9", status: "MYSTERY_BOX" },
  ];
  const { deps, opened } = makeDeps({ rows, participant: PARTICIPANT });
  const batch = buildOpenMysteryBoxBatch(deps);

  const result = await batch({ userId: "user-1", raceId: "race-1", powerupIds: ["mine", "theirs"] });
  assert.deepEqual(opened, ["mine"], "the foreign box is skipped");
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].powerupId, "mine");
});

test("is idempotent — a re-sent already-opened id returns its existing type/rarity, not an error", async () => {
  const rows = [
    { id: "b1", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "HELD", type: "SHORTCUT", rarity: "RARE" },
  ];
  const { deps, opened } = makeDeps({ rows, participant: PARTICIPANT });
  const batch = buildOpenMysteryBoxBatch(deps);

  const result = await batch({ userId: "user-1", raceId: "race-1", powerupIds: ["b1"] });
  assert.equal(opened.length, 0, "already-opened box is not re-rolled");
  assert.equal(result.results.length, 1);
  assert.deepEqual(result.results[0], { powerupId: "b1", type: "SHORTCUT", rarity: "RARE", autoActivated: false, alreadyOpened: true, queued: false });
});

test("materializes + opens queued overflow boxes when includeQueued is set", async () => {
  const rows = [
    { id: "slot", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "MYSTERY_BOX" },
    { id: "q1", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "QUEUED" },
    { id: "q2", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "QUEUED" },
  ];
  const { deps, store, opened } = makeDeps({ rows, participant: PARTICIPANT });
  const batch = buildOpenMysteryBoxBatch(deps);

  const result = await batch({ userId: "user-1", raceId: "race-1", powerupIds: ["slot"], includeQueued: true });

  // Slot box + both queued boxes opened.
  assert.deepEqual(opened.sort(), ["q1", "q2", "slot"]);
  assert.equal(result.results.length, 3);
  assert.equal(result.results.filter((r) => r.queued).length, 2);
  assert.equal(result.remainingQueuedBoxCount, 0);
  // Queued rows were materialized (QUEUED -> MYSTERY_BOX) before opening.
  assert.equal(store.get("q1").status, "HELD");
});

test("enforces maxCount across slot + queued boxes", async () => {
  const rows = [
    { id: "s1", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "MYSTERY_BOX" },
    { id: "q1", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "QUEUED" },
    { id: "q2", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "QUEUED" },
    { id: "q3", raceId: "race-1", userId: "user-1", participantId: "rp-1", status: "QUEUED" },
  ];
  const { deps, opened } = makeDeps({ rows, participant: PARTICIPANT });
  const batch = buildOpenMysteryBoxBatch(deps);

  const result = await batch({ userId: "user-1", raceId: "race-1", powerupIds: ["s1"], includeQueued: true, maxCount: 2 });
  assert.equal(result.results.length, 2, "capped at 2 total");
  assert.equal(opened.length, 2);
  assert.equal(result.remainingQueuedBoxCount, 2, "2 queued boxes remain unopened");
});
