// Feature batch 2026-07-25 — §9 / §9.2.
//
// Test 10 — the additive `characterPowersEnabled` field mirrors the server env
//           var, read PER REQUEST (it is a kill switch: flipping it back off
//           must make the home chip vanish with no redeploy).
// Test 18 — D7 flip safety. With CHARACTER_POWERS_ENABLED=true:
//             * a race with N capybaras credits the herd bonus into the
//               participant's bonus/step total on the progress payload;
//             * exactly ONE HERD_BONUS feed line per participant per race-local
//               day (the line is what explains the inflated total to every
//               frozen binary — the flip is rolled back if it is missing);
//             * box progress is UNCHANGED — the bonus is never folded into the
//               raw `baseAdjusted` the box countdown reads.
//           This is the test that protects the flip.
const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const {
  buildEmitHerdBonusFeed,
} = require("../../src/modules/races/jobs/characterEffectScheduler");

let server;
let nextAppleId = 0;
const quietLogger = { log: () => {}, error: () => {} };
const HEADERS = { "X-Client-Features": "characters,team_races,ads" };

async function createUser(displayName) {
  const appleId = `apple-cp25-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  const token = body.sessionToken;
  await request(server.baseUrl, "PUT", "/auth/me/display-name", {
    body: { displayName },
    token,
  });
  return { userId: body.user.id, token, displayName };
}

async function makeFriends(a, b) {
  const sendRes = await request(server.baseUrl, "POST", "/friends/request", {
    body: { addresseeId: b.userId },
    token: a.token,
  });
  const fId = (await sendRes.json()).friendship.id;
  await request(server.baseUrl, "PUT", `/friends/request/${fId}`, {
    body: { accept: true },
    token: b.token,
  });
}

async function createActiveRace(host, others) {
  const createRes = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: "Herd Flip Race",
      targetSteps: 500000,
      maxDurationDays: 7,
      powerupsEnabled: true,
      powerupStepInterval: 2000,
    },
    token: host.token,
  });
  const raceId = (await createRes.json()).race.id;
  await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
    body: { inviteeIds: others.map((o) => o.userId) },
    token: host.token,
  });
  for (const o of others) {
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: o.token,
    });
  }
  await request(server.baseUrl, "POST", `/races/${raceId}/start`, { token: host.token });

  // Backdate to UTC midnight and give everyone a real daily step row.
  const now = new Date();
  const startedAt = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  );
  await prisma.race.update({
    where: { id: raceId },
    data: {
      startedAt,
      endsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      timezone: "UTC",
    },
  });
  await prisma.raceParticipant.updateMany({
    where: { raceId },
    data: { joinedAt: startedAt, baselineSteps: 0, nextBoxAtSteps: 2000 },
  });
  for (const u of [host, ...others]) {
    await prisma.step.upsert({
      where: { userId_date: { userId: u.userId, date: startedAt } },
      update: { steps: 1500 },
      create: { userId: u.userId, steps: 1500, date: startedAt },
    });
  }
  return raceId;
}

async function progress(token, raceId) {
  const res = await request(server.baseUrl, "GET", `/races/${raceId}/progress`, {
    token,
    headers: HEADERS,
  });
  assert.equal(res.status, 200);
  return (await res.json()).progress;
}

async function homeCard(token) {
  const res = await request(server.baseUrl, "GET", "/home/race-card", {
    token,
    headers: HEADERS,
  });
  assert.equal(res.status, 200);
  return res.json();
}

describe("feature batch 2026-07-25 — §9 character powers", () => {
  const envBackup = {};
  before(async () => {
    server = await getSharedServer();
    envBackup.flag = process.env.CHARACTER_POWERS_ENABLED;
  });
  after(() => {
    if (envBackup.flag === undefined) delete process.env.CHARACTER_POWERS_ENABLED;
    else process.env.CHARACTER_POWERS_ENABLED = envBackup.flag;
  });
  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
    delete process.env.CHARACTER_POWERS_ENABLED;
  });

  // ── Test 10 ───────────────────────────────────────────────────────────────
  describe("test 10 — characterPowersEnabled reflects the env var both ways", () => {
    it("is false when the env var is unset", async () => {
      const user = await createUser("CpOffA");
      assert.equal((await homeCard(user.token)).characterPowersEnabled, false);
    });

    it("is false when the env var is any non-'true' value", async () => {
      process.env.CHARACTER_POWERS_ENABLED = "false";
      const user = await createUser("CpOffB");
      assert.equal((await homeCard(user.token)).characterPowersEnabled, false);
      process.env.CHARACTER_POWERS_ENABLED = "1";
      assert.equal((await homeCard(user.token)).characterPowersEnabled, false);
    });

    it("is true when the env var is 'true', and flips back on the very next request", async () => {
      const user = await createUser("CpOnA");
      process.env.CHARACTER_POWERS_ENABLED = "true";
      assert.equal((await homeCard(user.token)).characterPowersEnabled, true);
      // Kill switch: the next request must already report false.
      process.env.CHARACTER_POWERS_ENABLED = "false";
      assert.equal((await homeCard(user.token)).characterPowersEnabled, false);
    });

    it("is also exposed on the session payload (GET /auth/me)", async () => {
      const user = await createUser("CpMeA");
      process.env.CHARACTER_POWERS_ENABLED = "true";
      const res = await request(server.baseUrl, "GET", "/auth/me", {
        token: user.token,
        headers: HEADERS,
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.user.characterPowersEnabled, true);
      // And it is a live kill switch here too.
      process.env.CHARACTER_POWERS_ENABLED = "false";
      const off = await request(server.baseUrl, "GET", "/auth/me", {
        token: user.token,
        headers: HEADERS,
      });
      assert.equal((await off.json()).user.characterPowersEnabled, false);
    });
  });

  // ── Test 18 ───────────────────────────────────────────────────────────────
  describe("test 18 — D7 flip safety (herd bonus)", () => {
    async function fourCapybaraRace() {
      const host = await createUser("HerdFlipA");
      const others = [];
      for (const n of ["HerdFlipB", "HerdFlipC", "HerdFlipD"]) {
        const u = await createUser(n);
        await makeFriends(host, u);
        others.push(u);
      }
      const raceId = await createActiveRace(host, others);
      return { host, others, raceId };
    }

    it("credits the herd bonus into the scored total and reports it as a bonus block, with box progress unchanged", async () => {
      const { host, raceId } = await fourCapybaraRace();

      // Baseline with the flag OFF: raw walked steps only.
      const before = await progress(host.token, raceId);
      const meBefore = before.participants.find((p) => p.userId === host.userId);
      assert.equal(meBefore.totalSteps, 1500, "raw walked steps");
      assert.equal(meBefore.characterBonus, undefined, "no bonus while the flag is off");
      const boxBefore = before.powerupData.stepsUntilNextPowerup;
      assert.equal(boxBefore, 500, "2000 interval - 1500 raw steps");

      // Flip the flag ON.
      process.env.CHARACTER_POWERS_ENABLED = "true";
      const after = await progress(host.token, raceId);
      const meAfter = after.participants.find((p) => p.userId === host.userId);

      // 100 x 4 capybaras = +400 bonus steps, folded into the scored total.
      assert.ok(meAfter.characterBonus, "the bonus block is reported");
      assert.equal(meAfter.characterBonus.animal, "capybara");
      assert.equal(meAfter.characterBonus.bonusSteps, 400);
      assert.equal(meAfter.totalSteps, 1900, "1500 raw + 400 herd bonus");

      // THE INVARIANT: box progress is raw baseAdjusted only. The bonus must
      // never move a box.
      assert.equal(
        after.powerupData.stepsUntilNextPowerup,
        boxBefore,
        "herd bonus must never move box progress"
      );
      // And no box was minted off the inflated total.
      const boxes = await prisma.racePowerup.count({
        where: { raceId, userId: host.userId, status: { in: ["MYSTERY_BOX", "QUEUED"] } },
      });
      assert.equal(boxes, 0, "1500 raw steps is still short of the 2000 interval");
    });

    it("is never persisted as bonusSteps rows (it is an assembly-time term only)", async () => {
      const { host, raceId } = await fourCapybaraRace();
      process.env.CHARACTER_POWERS_ENABLED = "true";
      await progress(host.token, raceId);

      const rows = await prisma.raceParticipant.findMany({ where: { raceId } });
      for (const r of rows) {
        assert.equal(r.bonusSteps || 0, 0, "the herd bonus is never minted as a row");
      }
    });

    it("emits exactly one HERD_BONUS feed line per participant per race-local day", async () => {
      const { host, raceId } = await fourCapybaraRace();
      process.env.CHARACTER_POWERS_ENABLED = "true";
      const run = buildEmitHerdBonusFeed({ logger: quietLogger });

      await run();
      await run(); // a second cron tick the same day must add nothing

      const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
        token: host.token,
        headers: HEADERS,
      });
      assert.equal(res.status, 200);
      const lines = (await res.json()).events.filter((e) => e.eventType === "HERD_BONUS");
      assert.equal(lines.length, 4, "one line per capybara participant, deduped");
      const perUser = new Map();
      for (const l of lines) {
        perUser.set(l.actorUserId, (perUser.get(l.actorUserId) || 0) + 1);
      }
      for (const [, count] of perUser) assert.equal(count, 1);
      // The line is server-rendered, so every frozen binary can read it.
      const mine = lines.find((l) => l.actorUserId === host.userId);
      assert.match(mine.description, /Herd Bonus/);
      assert.match(mine.description, /\+400 steps/);
    });

    it("with the flag OFF nothing changes: no bonus, no feed line", async () => {
      const { host, raceId } = await fourCapybaraRace();
      await buildEmitHerdBonusFeed({ logger: quietLogger })();

      const p = await progress(host.token, raceId);
      const me = p.participants.find((x) => x.userId === host.userId);
      assert.equal(me.totalSteps, 1500);
      assert.equal(me.characterBonus, undefined);

      const res = await request(server.baseUrl, "GET", `/races/${raceId}/feed`, {
        token: host.token,
        headers: HEADERS,
      });
      const lines = (await res.json()).events.filter((e) => e.eventType === "HERD_BONUS");
      assert.equal(lines.length, 0);
    });
  });
});
