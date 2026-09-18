const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { randomUUID } = require("node:crypto");
const { prisma, cleanDatabase, createTestUser } = require("./setup");
const { buildHistoricalRaceDiscovery } = require("../../src/modules/races/services/historicalRaceDiscovery");
const { buildHistoricalRaceDiscoveryCursorModel } = require("../../src/modules/races/models/historicalRaceDiscoveryCursor");
const { buildHistoricalRaceReconciliationIntentModel } = require("../../src/modules/races/models/historicalRaceReconciliationIntent");

describe("historical discovery durable overflow", () => {
  beforeEach(cleanDatabase);

  it("eventually admits every race through a durable keyset cursor", async () => {
    const account = await createTestUser();
    const now = new Date();
    const raceIds = [];
    const participantRows = [];
    const raceRows = [];
    for (let i = 0; i < 1000; i += 1) {
      const raceId = randomUUID();
      const participantId = randomUUID();
      raceIds.push(raceId);
      raceRows.push({ id: raceId, creatorId: account.user.id, name: `Overflow ${i}`, status: "COMPLETED", targetSteps: 100000, startedAt: new Date(now - 3600000), endsAt: new Date(now - 1800000), completedAt: new Date(now - 1800000), maxParticipants: 10 });
      participantRows.push({ id: participantId, raceId, userId: account.user.id, status: "ACCEPTED", joinedAt: new Date(now - 3600000) });
    }
    await prisma.race.createMany({ data: raceRows });
    await prisma.raceParticipant.createMany({ data: participantRows });

    const discovery = buildHistoricalRaceDiscovery({ prisma, now: () => now });
    const cursorModel = buildHistoricalRaceDiscoveryCursorModel(prisma);
    const intents = buildHistoricalRaceReconciliationIntentModel(prisma);
    await cursorModel.upsert({ userId: account.user.id, changedStart: new Date(now - 3000000), changedEnd: new Date(now - 1000000), sourceGeneration: 7, now });
    const seen = new Set();
    let pages = 0;
    while (true) {
      const cursor = await cursorModel.claim(now);
      assert.ok(cursor);
      const page = await discovery({ userId: account.user.id, changedStart: cursor.changed_start, changedEnd: cursor.changed_end, cursor: cursor.cursor_race_id ? { raceId: cursor.cursor_race_id, participantId: cursor.cursor_participant_id } : null, limit: 100 });
      pages += 1;
      for (const row of page.rows) seen.add(row.raceId);
      await intents.admitMany({ rows: page.rows, changedStart: cursor.changed_start, changedEnd: cursor.changed_end, sourceGeneration: cursor.requested_source_generation, now });
      await cursorModel.advance(cursor, page.nextCursor, !page.nextCursor, now);
      if (!page.nextCursor) break;
    }
    assert.ok(pages <= 11);
    assert.equal(seen.size, 1000);
    assert.equal(await prisma.historicalRaceReconciliationIntent.count(), 1000);
  });
});
