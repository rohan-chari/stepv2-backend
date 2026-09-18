const assert = require("node:assert/strict");
const { before, beforeEach, it } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
let server;
before(async () => { server = await getSharedServer(); });
beforeEach(cleanDatabase);
async function signup(identityToken) {
  const response = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken } });
  assert.equal(response.status, 200);
  return response.json();
}
it("seeded account erasure rolls back atomically, removes live references and preserves anonymous history and peers", async () => {
  const account = await signup("apple-seeded-erasure");
  const peer = await signup("apple-seeded-erasure-peer");
  const userId = account.user.id;
  const assignments = await prisma.seededRaceBucketAssignment.findMany({ where: { userId } });
  const memberships = await prisma.seededRaceWindowMembership.findMany({ where: { userId } });
  const peerAssignments = await prisma.seededRaceBucketAssignment.findMany({ where: { userId: peer.user.id } });
  assert.equal(assignments.length, 2);
  assert.equal(memberships.length, 2);
  assert.equal(peerAssignments.length, 2);
  const historic = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: assignments[0].raceParticipantId } });
  await prisma.race.update({ where: { id: historic.raceId }, data: { status: "COMPLETED" } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION test_reject_seeded_account_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test deletion rollback'; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER test_reject_seeded_account_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION test_reject_seeded_account_delete()`);
  try {
    const failed = await request(server.baseUrl, "DELETE", "/auth/account", { token: account.sessionToken });
    assert.equal(failed.status, 500);
    assert.ok(await prisma.user.findUnique({ where: { id: userId } }));
    assert.deepEqual(await prisma.seededRaceBucketAssignment.findMany({ where: { userId } }), assignments);
    assert.deepEqual(await prisma.seededRaceWindowMembership.findMany({ where: { userId } }), memberships);
  } finally {
    await prisma.$executeRawUnsafe("DROP TRIGGER test_reject_seeded_account_delete ON users");
    await prisma.$executeRawUnsafe("DROP FUNCTION test_reject_seeded_account_delete()");
  }
  const deleted = await request(server.baseUrl, "DELETE", "/auth/account", { token: account.sessionToken });
  assert.equal(deleted.status, 204);
  assert.equal(await prisma.user.count({ where: { id: userId } }), 0);
  assert.equal(await prisma.seededRaceBucketAssignment.count({ where: { userId } }), 0);
  assert.equal(await prisma.seededRaceWindowMembership.count({ where: { userId } }), 0);
  assert.equal(await prisma.raceParticipant.count({ where: { userId } }), 0);
  assert.equal(await prisma.raceParticipant.count({ where: { id: assignments[1].raceParticipantId } }), 0);
  const preserved = await prisma.raceParticipant.findUniqueOrThrow({ where: { id: historic.id } });
  assert.notEqual(preserved.userId, userId);
  assert.equal(preserved.totalSteps, historic.totalSteps);
  assert.deepEqual(await prisma.seededRaceBucketAssignment.findMany({ where: { userId: peer.user.id } }), peerAssignments);
});
