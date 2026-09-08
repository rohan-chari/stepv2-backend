const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { describe, it, before, beforeEach, after } = require("node:test");

// The production command captures Math.random when loaded. Pin that RNG only
// during module loading, then restore the global; no collaborator injection may
// select the command's lightweight unit-test transaction path.
let powerupRandom = seededRandom(20260908);
const originalRandom = Math.random;
Math.random = () => powerupRandom();
// Observe real SQL, without replacing any command, model, transaction or queue.
process.env.PRISMA_QUERY_EVENTS_ENABLED = "true";
const { prisma, cleanDatabase, startServer, createTestUser, request } = require("./setup");
Math.random = originalRandom;
delete process.env.PRISMA_QUERY_EVENTS_ENABLED;

const HEADERS = { "X-Client-Features": "powerups2,powerups3,powerups4,powerups5", "X-Timezone": "UTC" };
const RECIPIENTS = 2000;
let server;
let queries = null;

function seededRandom(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

async function fixture() {
  const caster = await createTestUser({ displayName: "Outage Caster" });
  const race = await prisma.race.create({ data: {
    creatorId: caster.user.id, name: "2000-recipient weekly outage",
    status: "ACTIVE", timeBased: true, maxDurationDays: 7, targetSteps: 1000000, maxParticipants: null,
    startedAt: new Date(Date.now() - 60000), endsAt: new Date(Date.now() + 7 * 86400000),
    timezone: "UTC", powerupsEnabled: true, powerupStepInterval: 5000,
  } });
  const random = seededRandom(20002026);
  const players = Array.from({ length: RECIPIENTS }, (_, index) => ({
    // Stable user ordering makes the seeded defense layout reproducible.
    userId: `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    participantId: randomUUID(), kind: Math.floor(random() * 10),
  }));
  await prisma.user.createMany({ data: players.map((p) => ({
    id: p.userId, appleId: `outage-${p.userId}`, displayName: `Recipient${p.userId.slice(-12)}`,
  })) });
  const casterParticipantId = randomUUID();
  await prisma.raceParticipant.createMany({ data: [
    { id: casterParticipantId, raceId: race.id, userId: caster.user.id, status: "ACCEPTED", joinedAt: new Date(Date.now() - 3000000) },
    ...players.map((p, index) => ({ id: p.participantId, raceId: race.id, userId: p.userId, status: "ACCEPTED",
      joinedAt: new Date(Date.now() - (RECIPIENTS - index) * 1000) })),
  ] });
  const powerups = [];
  const defenses = [];
  const start = new Date(Date.now() - 60000);
  function defense(p, type, expired = false) {
    const powerupId = randomUUID();
    powerups.push({ id: powerupId, raceId: race.id, participantId: p.participantId,
      userId: p.userId, type, rarity: "RARE", status: "USED", earnedAtSteps: powerups.length + 1 });
    defenses.push({ id: randomUUID(), raceId: race.id, targetParticipantId: p.participantId,
      targetUserId: p.userId, sourceUserId: p.userId, powerupId, type, status: "ACTIVE",
      startsAt: start, expiresAt: new Date(Date.now() + (expired ? -1000 : 86400000)) });
  }
  for (const p of players) {
    if (p.kind === 4 || p.kind === 6) defense(p, "UMBRELLA");
    if (p.kind === 5 || p.kind === 6) defense(p, "COMPRESSION_SOCKS");
    if (p.kind === 7) defense(p, "DECOY");
    if (p.kind === 8) defense(p, "COMPRESSION_SOCKS", true);
    if (p.kind === 9) defense(p, "POWER_OUTAGE");
  }
  // Durable boundary attribution must preserve a hidden caster in bulk writes.
  defense({ userId: caster.user.id, participantId: casterParticipantId }, "STEALTH_MODE");
  const outageId = randomUUID();
  powerups.push({ id: outageId, raceId: race.id, participantId: casterParticipantId,
    userId: caster.user.id, type: "POWER_OUTAGE", rarity: "RARE", status: "HELD", earnedAtSteps: 0 });
  await prisma.racePowerup.createMany({ data: powerups });
  await prisma.raceActiveEffect.createMany({ data: defenses });
  return { caster, race, players, defenses, outageId };
}

describe("Power Outage — 2000 recipients over real HTTP/Postgres", () => {
  before(async () => {
    // Check the disposable identity before even starting the application.
    const url = new URL(process.env.DATABASE_URL);
    assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
    assert.match(url.pathname, /_test$/);
    server = await startServer({ verifyAppleIdentityToken: async (token) => ({ sub: token }) });
    prisma.$on("query", (event) => { if (queries) queries.push(event.query); });
  });
  beforeEach(cleanDatabase);
  after(async () => { await server?.close(); });

  it("rolls back every recipient, defense and durable event if final consumption fails", { timeout: 120000 }, async () => {
    const f = await fixture();
    // Real database failure at the final write, after all recipient work. No
    // command imports or mocked collaborators bypass the public transaction.
    await prisma.$executeRawUnsafe(`CREATE FUNCTION outage_test_reject_consumption() RETURNS trigger AS $$
      BEGIN
        IF NEW.type = 'POWER_OUTAGE' AND NEW.status = 'USED' AND OLD.status = 'HELD' THEN
          RAISE EXCEPTION 'outage test final consumption failure';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    try {
      await prisma.$executeRawUnsafe(`CREATE TRIGGER outage_test_reject_consumption
        BEFORE UPDATE ON race_powerups FOR EACH ROW EXECUTE FUNCTION outage_test_reject_consumption()`);
      const response = await request(server.baseUrl, "POST", `/races/${f.race.id}/powerups/${f.outageId}/use`, {
        token: f.caster.token, headers: HEADERS, body: {},
      });
      assert.equal(response.status, 500);
      assert.equal(await prisma.raceActiveEffect.count({ where: { powerupId: f.outageId } }), 0);
      assert.equal(await prisma.raceActiveEffect.count({ where: { raceId: f.race.id, status: { not: "ACTIVE" } } }), 0);
      assert.equal(await prisma.domainEventOutbox.count({ where: { payload: { path: ["raceId"], equals: f.race.id } } }), 0);
      assert.equal(await prisma.domainEventReceipt.count(), 0);
      assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id } }), 0);
      assert.equal((await prisma.racePowerup.findUnique({ where: { id: f.outageId } })).status, "HELD");
    } finally {
      await prisma.$executeRawUnsafe("DROP TRIGGER IF EXISTS outage_test_reject_consumption ON race_powerups");
      await prisma.$executeRawUnsafe("DROP FUNCTION outage_test_reject_consumption()");
    }
  });

  // Repeated independent fixtures provide a comparison without timing setup or
  // weakening the production 30-second transaction deadline. SQL count, rather
  // than a flaky laptop wall-clock threshold, guards the scaling regression.
  for (let run = 1; run <= 3; run += 1) {
    it(`applies atomic, defense-correct fanout with bounded SQL (run ${run})`, { timeout: 120000 }, async (t) => {
      const f = await fixture();
      // Pin only RNG, not the command/model seams (which select a different
      // transaction path). Both benchmark revisions get the same Decoy draws.
      powerupRandom = seededRandom(20260908);
      queries = [];
      const started = performance.now();
      const response = await request(server.baseUrl, "POST", `/races/${f.race.id}/powerups/${f.outageId}/use`, {
        token: f.caster.token, headers: HEADERS, body: {},
      });
      const body = await response.json();
      const elapsedMs = performance.now() - started;
      const queryCount = queries.length;
      queries = null;
      t.diagnostic(JSON.stringify({ benchmark: "power-outage-2000", run, recipients: RECIPIENTS,
        elapsedMs: Math.round(elapsedMs), queryCount, status: response.status, affected: body.result?.affected }));
      assert.equal(response.status, 200, JSON.stringify(body));
      const result = body.result;
      assert.equal(result.affected, 1025, "fixed defense layout and Decoy draws retain the baseline outcome");
      const redirects = new Set(result.redirectedToUserIds);
      const landed = f.players.filter((p) => p.kind !== 7 || redirects.has(p.userId));
      const expected = landed.filter((p) => ![4, 5, 6, 9].includes(p.kind));
      const blocked = landed.filter((p) => p.kind === 5);
      assert.equal(result.affected, expected.length);
      assert.equal(result.blockedCount, blocked.length);
      assert.equal(result.decoyBlockedCount, 0);
      assert.equal(result.durationMs, 1800000);
      assert.equal(result.outcome, "APPLIED");
      const effects = await prisma.raceActiveEffect.findMany({ where: { powerupId: f.outageId } });
      assert.deepEqual(effects.map((e) => e.targetUserId).sort(), expected.map((p) => p.userId).sort());
      assert.equal(new Set(effects.map((e) => e.startsAt.getTime())).size, 1);
      for (const e of effects) {
        assert.equal(e.status, "ACTIVE");
        assert.equal(e.expiresAt - e.startsAt, 1800000);
        assert.deepEqual(e.metadata.impactBoundaryV1, {
          version: 1, responsibleActorUserId: f.caster.user.id, attackerDisplayName: "???",
          attackerHidden: true, originalExpiresAt: e.expiresAt.toISOString(), endReason: "NATURAL",
        });
      }
      const updated = await prisma.raceActiveEffect.findMany({ where: { id: { in: f.defenses.map((e) => e.id) } } });
      const playerById = new Map(f.players.map((p) => [p.userId, p]));
      for (const e of updated) {
        const p = playerById.get(e.targetUserId);
        const expectedStatus = e.type === "DECOY" ? "EXPIRED"
          : e.type === "COMPRESSION_SOCKS" && p?.kind === 5 ? "BLOCKED" : "ACTIVE";
        assert.equal(e.status, expectedStatus, `${e.type} for kind ${p?.kind}`);
        const original = f.defenses.find((d) => d.id === e.id);
        assert.equal(e.expiresAt.getTime(), original.expiresAt.getTime(), "existing windows unchanged");
      }
      const domainEvents = await prisma.domainEventOutbox.findMany({
        where: { aggregateId: f.outageId, eventType: "POWERUP_USED_V1" }, include: { audience: true },
      });
      assert.deepEqual(domainEvents.map((e) => e.payload.targetUserId).sort(), expected.map((p) => p.userId).sort());
      for (const event of domainEvents) {
        assert.equal(event.payload.stealthed, true);
        assert.equal(event.eventKey, `POWERUP_USED_V1:${f.outageId}:${event.payload.targetUserId}`);
        assert.deepEqual(event.audience.map((a) => a.recipientId), [event.payload.targetUserId]);
      }
      assert.equal(await prisma.domainEventReceipt.count({ where: { eventKey: { in: domainEvents.map((e) => e.eventKey) }, receiptState: "FINAL" } }), expected.length);
      assert.equal(await prisma.domainEventOutbox.count({ where: { eventKey: { in: f.defenses.filter((e) => e.type === "DECOY").map((e) => `DECOY_CONSUMED_V1:${e.id}`) } } }), f.players.filter((p) => p.kind === 7).length);
      assert.equal(await prisma.racePowerupEvent.count({ where: { raceId: f.race.id, eventType: "POWERUP_BLOCKED" } }), blocked.length);
      const used = await prisma.racePowerup.findUnique({ where: { id: f.outageId } });
      assert.equal(used.status, "USED");

      // Verify the recipient's actual public use path enforces the committed jam.
      const victim = expected.find((p) => p.kind === 8);
      const held = await prisma.racePowerup.create({ data: { raceId: f.race.id, participantId: victim.participantId,
        userId: victim.userId, type: "PROTEIN_SHAKE", rarity: "COMMON", status: "HELD", earnedAtSteps: 900000 } });
      const login = await request(server.baseUrl, "POST", "/auth/apple", { body: { identityToken: `outage-${victim.userId}` } });
      assert.equal(login.status, 200);
      const victimToken = (await login.json()).sessionToken;
      const rejected = await request(server.baseUrl, "POST", `/races/${f.race.id}/powerups/${held.id}/use`, { token: victimToken, headers: HEADERS, body: {} });
      assert.equal(rejected.status, 409);
      assert.match((await rejected.json()).error, /jammed/);
      assert.ok(queryCount <= 250, `2000-recipient cast must use bounded bulk SQL; observed ${queryCount} statements`);
    });
  }
});
