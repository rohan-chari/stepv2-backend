const assert = require("node:assert/strict");
const test = require("node:test");

const {
  findLegacyPublicRaceCandidates,
  findNextRaceCandidates,
} = require("../../src/modules/races/queries/publicRaceHomeCandidates");

function sqlText(query) {
  return query?.text || query?.strings?.join("?") || String(query);
}

test("legacy Home public discovery limits candidates before counting participants", async () => {
  let statement;
  const prisma = { $queryRaw: async (query) => {
    statement = sqlText(query);
    return [{ id: "race-1", participantCount: 4, seedKind: "DAILY_10K" }];
  } };

  const rows = await findLegacyPublicRaceCandidates({ prisma, userId: "viewer-1" });
  assert.equal(rows[0].participantCount, 4);
  assert.match(statement, /WITH candidates AS MATERIALIZED/i);
  assert.match(statement, /LIMIT 25[\s\S]+FROM candidates c[\s\S]+LATERAL/i);
  assert.match(statement, /NOT EXISTS[\s\S]+mine\.user_id/i);
});

test("next-race discovery limits candidates before hydrating creators and counts", async () => {
  let statement;
  const prisma = { $queryRaw: async (query) => {
    statement = sqlText(query);
    return [{ id: "race-1", participantCount: 2, creatorId: "host-1" }];
  } };

  const rows = await findNextRaceCandidates({
    prisma,
    userId: "viewer-1",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(rows[0].participantCount, 2);
  assert.match(statement, /WITH candidates AS MATERIALIZED/i);
  assert.match(statement, /LIMIT 24[\s\S]+FROM candidates c[\s\S]+LATERAL/i);
  assert.match(statement, /JOIN users creator/i);
});
