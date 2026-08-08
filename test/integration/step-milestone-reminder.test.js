const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, after } = require("node:test");

const {
  cleanDatabase,
  prisma,
  request,
  getSharedServer,
  createTestUser,
} = require("./setup");

const {
  buildStepMilestoneReminder,
} = require("../../src/modules/notifications/stepMilestoneReminder");

// Batch 2026-08-08 item 3 — evening reminder push for uncollected milestone
// coins.
//
// Two surfaces, both exercised end to end:
//   1. the cron job, driven through its exported build* function against the
//      real test DB (the established pattern for cron jobs in this repo), and
//   2. GET/PATCH /notifications/preferences over real HTTP through the real
//      handler chain, including the FROZEN-CLIENT contract (an old client that
//      never sends the new field must never disturb it).

const ZONE = "America/New_York";
// 19:05 EDT on 2026-08-08 -> inside the 19:00 slot's 30-minute catch-up window.
const NOW_AT_SLOT = new Date("2026-08-08T23:05:00Z");
const LOCAL_DATE = "2026-08-08";
// 15:05 EDT — no zone is at the slot.
const NOW_OFF_SLOT = new Date("2026-08-08T19:05:00Z");

let server;
let seq = 0;

async function req(method, path, { body, token, headers } = {}) {
  const res = await request(server.baseUrl, method, path, {
    body,
    token,
    headers,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {}
  return { status: res.status, body: parsed };
}

async function makeUser({
  timezone = ZONE,
  steps = 12000,
  stepDate = LOCAL_DATE,
  withToken = true,
  stepMilestoneRemindersEnabled = true,
} = {}) {
  const { user, token } = await createTestUser({
    appleId: `apple-smr-${++seq}`,
    email: `smr-${seq}@example.com`,
    timezone,
    stepMilestoneRemindersEnabled,
  });
  if (steps !== null) {
    await prisma.step.create({
      data: { userId: user.id, steps, date: new Date(`${stepDate}T00:00:00Z`) },
    });
  }
  if (withToken) {
    await prisma.deviceToken.create({
      data: { userId: user.id, token: `tok-${seq}`, platform: "ios" },
    });
  }
  return { userId: user.id, token };
}

async function addClaim(userId, claimedDate, threshold = 5000, coins = 10) {
  await prisma.stepMilestoneClaim.create({
    data: { userId, claimedDate, threshold, coins },
  });
}

// Drive one tick with the real DB models and a capturing event bus. The job's
// only side effects we assert on are the Notification rows it writes and the
// events it emits.
function runTick({ now = NOW_AT_SLOT, disabled = false } = {}) {
  const emitted = [];
  const run = buildStepMilestoneReminder({
    now: () => now,
    isDisabled: () => disabled,
    eventBus: { emit: (name, data) => emitted.push({ name, data }) },
    logger: { log() {}, error() {}, warn() {} },
  });
  return run().then((result) => ({ result, emitted }));
}

async function notificationsFor(userId) {
  return prisma.notification.findMany({
    where: { userId, type: "STEP_MILESTONE_REMINDER" },
  });
}

describe("step-milestone evening reminder (batch 2026-08-08 item 3)", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    // job_runs is NOT in the shared truncate list; the per-zone CAS row would
    // otherwise leak across tests and make later ticks no-ops.
    await prisma.jobRun.deleteMany({});
    await prisma.notification.deleteMany({});
  });

  after(async () => {
    await prisma.jobRun.deleteMany({});
  });

  describe("cron job", () => {
    it("sends exactly one notification per local day, even across two ticks", async () => {
      const { userId } = await makeUser();

      const first = await runTick();
      assert.equal(first.emitted.length, 1);
      assert.equal(first.emitted[0].name, "STEP_MILESTONE_REMINDER");
      assert.equal(first.emitted[0].data.userId, userId);
      assert.deepEqual(
        (await notificationsFor(userId)).map((n) => n.deliveryKey),
        [`step-milestone:${userId}:${LOCAL_DATE}`]
      );

      // Release the per-zone JobRun CAS so the second tick really re-scans the
      // user set — the deliveryKey unique index is what must stop the dupe.
      await prisma.jobRun.deleteMany({});
      const second = await runTick();
      assert.equal(second.emitted.length, 0, "no second emit");
      assert.equal((await notificationsFor(userId)).length, 1);
    });

    it("does nothing outside the 19:00 catch-up window", async () => {
      const { userId } = await makeUser();
      const { emitted } = await runTick({ now: NOW_OFF_SLOT });
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("skips users below the first milestone", async () => {
      const { userId } = await makeUser({ steps: 4999 });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("skips users with no steps row for the local date", async () => {
      const { userId } = await makeUser({ steps: null });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("skips a user whose steps only reach a threshold they already claimed", async () => {
      // 7,000 steps crosses exactly one threshold (5,000) and it is claimed.
      const { userId } = await makeUser({ steps: 7000 });
      await addClaim(userId, LOCAL_DATE, 5000, 10);
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("skips users who opted out (stepMilestoneRemindersEnabled=false)", async () => {
      const { userId } = await makeUser({ stepMilestoneRemindersEnabled: false });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("skips users with no device tokens", async () => {
      const { userId } = await makeUser({ withToken: false });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("emits nothing at all when the kill switch is on", async () => {
      const { userId } = await makeUser();
      const { result, emitted } = await runTick({ disabled: true });
      assert.deepEqual(result, []);
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
      assert.equal(await prisma.jobRun.count(), 0, "no CAS row claimed");
    });

    it("suppresses when a claim is dated the local date", async () => {
      const { userId } = await makeUser();
      await addClaim(userId, LOCAL_DATE);
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("suppresses when a claim is dated localDate-1 (client clock skew)", async () => {
      const { userId } = await makeUser();
      await addClaim(userId, "2026-08-07");
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("suppresses when a claim is dated localDate+1 (client clock skew)", async () => {
      const { userId } = await makeUser();
      await addClaim(userId, "2026-08-09");
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("does not suppress on a claim two days away", async () => {
      const { userId } = await makeUser();
      await addClaim(userId, "2026-08-06");
      const { emitted } = await runTick();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].data.userId, userId);
    });

    it("includes null-timezone users in the default zone bucket", async () => {
      const { userId } = await makeUser({ timezone: null });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 1);
      assert.equal(emitted[0].data.userId, userId);
    });

    it("does not remind a user whose own zone is not at the slot", async () => {
      // 19:05 in New York is 16:05 in Los Angeles.
      const { userId } = await makeUser({ timezone: "America/Los_Angeles" });
      const { emitted } = await runTick();
      assert.equal(emitted.length, 0);
      assert.equal((await notificationsFor(userId)).length, 0);
    });

    it("carries the approved copy on the audit row and the event", async () => {
      const { userId } = await makeUser();
      const { emitted } = await runTick();
      const [row] = await notificationsFor(userId);
      assert.equal(row.title, "Coins waiting! 🪙");
      assert.equal(
        row.body,
        "You crossed a step milestone today — collect your coins before midnight."
      );
      assert.equal(emitted[0].data.title, row.title);
      assert.equal(emitted[0].data.body, row.body);
    });
  });

  describe("GET/PATCH /notifications/preferences", () => {
    it("GET returns both prefs, defaulting to true", async () => {
      const { token } = await makeUser();
      const res = await req("GET", "/notifications/preferences", { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.dailyRewardRemindersEnabled, true);
      assert.equal(res.body.stepMilestoneRemindersEnabled, true);
    });

    it("PATCH persists stepMilestoneRemindersEnabled and GET reflects it", async () => {
      const { userId, token } = await makeUser();
      const patch = await req("PATCH", "/notifications/preferences", {
        token,
        body: { stepMilestoneRemindersEnabled: false },
      });
      assert.equal(patch.status, 200);
      assert.equal(patch.body.stepMilestoneRemindersEnabled, false);
      assert.equal(patch.body.dailyRewardRemindersEnabled, true);

      const get = await req("GET", "/notifications/preferences", { token });
      assert.equal(get.body.stepMilestoneRemindersEnabled, false);

      const row = await prisma.user.findUnique({ where: { id: userId } });
      assert.equal(row.stepMilestoneRemindersEnabled, false);
    });

    it("PATCH with a non-boolean stepMilestoneRemindersEnabled is 400", async () => {
      const { userId, token } = await makeUser();
      const res = await req("PATCH", "/notifications/preferences", {
        token,
        body: { stepMilestoneRemindersEnabled: "yes" },
      });
      assert.equal(res.status, 400);
      const row = await prisma.user.findUnique({ where: { id: userId } });
      assert.equal(row.stepMilestoneRemindersEnabled, true, "unchanged");
    });

    // FROZEN-CLIENT CONTRACT ------------------------------------------------
    it("GET still returns dailyRewardRemindersEnabled with its old meaning", async () => {
      const { userId, token } = await makeUser();
      await prisma.user.update({
        where: { id: userId },
        data: { dailyRewardRemindersEnabled: false },
      });
      const res = await req("GET", "/notifications/preferences", { token });
      assert.equal(res.status, 200);
      assert.equal(res.body.dailyRewardRemindersEnabled, false);
    });

    it("an old-shape PATCH (daily-reward only) leaves the new pref untouched", async () => {
      const { userId, token } = await makeUser();
      const res = await req("PATCH", "/notifications/preferences", {
        token,
        body: { dailyRewardRemindersEnabled: false },
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.dailyRewardRemindersEnabled, false);
      const row = await prisma.user.findUnique({ where: { id: userId } });
      assert.equal(row.dailyRewardRemindersEnabled, false);
      assert.equal(row.stepMilestoneRemindersEnabled, true, "untouched");

      // And the same in reverse: a new-field-only PATCH leaves the old one.
      await req("PATCH", "/notifications/preferences", {
        token,
        body: { stepMilestoneRemindersEnabled: false },
      });
      const after = await prisma.user.findUnique({ where: { id: userId } });
      assert.equal(after.dailyRewardRemindersEnabled, false, "still false");
      assert.equal(after.stepMilestoneRemindersEnabled, false);
    });

    it("an empty PATCH body changes nothing and echoes both prefs", async () => {
      const { userId, token } = await makeUser();
      await prisma.user.update({
        where: { id: userId },
        data: { stepMilestoneRemindersEnabled: false },
      });
      const res = await req("PATCH", "/notifications/preferences", {
        token,
        body: {},
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.dailyRewardRemindersEnabled, true);
      assert.equal(res.body.stepMilestoneRemindersEnabled, false);
      const row = await prisma.user.findUnique({ where: { id: userId } });
      assert.equal(row.dailyRewardRemindersEnabled, true, "unchanged");
      assert.equal(row.stepMilestoneRemindersEnabled, false, "unchanged");
    });

    it("preferences require auth", async () => {
      const res = await req("GET", "/notifications/preferences", {});
      assert.equal(res.status, 401);
    });
  });
});
