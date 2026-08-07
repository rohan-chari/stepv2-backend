// Integration tests for the two backend-only referral-attribution fixes
// (2026-08-07, motivated by the emersonz incident — real referrals whose code
// never reached the backend, then locked out of manual entry by auto-enroll):
//
//  1. IP-correlated deferred attribution: the referral landing page records a
//     hashed client IP on its link_opens row; when a brand-new user provisions
//     WITHOUT a referralCode in the body, the backend attributes them to the
//     code whose link was opened from the same IP within the fallback window —
//     but ONLY when that IP saw exactly one distinct code (ambiguity = no-op).
//
//  2. Late manual entry (POST /referrals/redeem) no longer counts SEEDED races
//     toward the already_raced guard — signup auto-enrolls users into seeded
//     dailies that settle within ~24h through no action of their own, which
//     used to slam the manual-entry door overnight. Races the user chose to
//     join (seedId null) still block, preserving the anti-gaming intent.
//
// Walked end-to-end through the real HTTP surface: GET /r/:code (landing page),
// POST /auth/apple (provision), POST /referrals/redeem — real DB, real handler
// chain, per CLAUDE.md integration-first.

const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");

const {
  prisma,
  cleanDatabase,
  getSharedServer,
  getBaseUrl,
  request,
  createTestUser,
} = require("./setup");

let seq = 0;

async function makeReferrer(code) {
  seq += 1;
  return prisma.user.create({
    data: {
      appleId: `apple-fallback-${seq}`,
      email: `fallback-${seq}@example.com`,
      displayName: `Referrer ${seq}`,
      referralCode: code,
    },
  });
}

// Open the referral landing page as a given client IP (nginx-style header).
// logLinkOpen is fire-and-forget, so the page can respond before the row
// commits; poll until it lands (a real user takes minutes to install, not ms).
async function openLanding(code, ip) {
  const before = await prisma.linkOpen.count({ where: { code } });
  const res = await fetch(`${getBaseUrl()}/r/${code}`, {
    headers: { "X-Forwarded-For": ip },
  });
  for (let i = 0; i < 50; i++) {
    if ((await prisma.linkOpen.count({ where: { code } })) > before) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return res;
}

// Provision a brand-new Apple user (shared-server stub: sub = identityToken).
async function provision(sub, { referralCode, ip } = {}) {
  const res = await fetch(`${getBaseUrl()}/auth/apple`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(ip ? { "X-Forwarded-For": ip } : {}),
    },
    body: JSON.stringify({ identityToken: sub, referralCode }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).user;
}

async function referralOf(refereeId) {
  return prisma.referral.findUnique({ where: { refereeId } });
}

before(async () => {
  await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  // Neither link_opens nor race_seeds are in cleanDatabase's TRUNCATE list
  // (no FK to users) — clear our fixtures explicitly so re-runs don't collide.
  await prisma.linkOpen.deleteMany({});
  await prisma.raceSeed.deleteMany({ where: { kind: "TEST_FALLBACK" } });
});

// ---------------------------------------------------------------------------
// 1. IP-correlated deferred attribution
// ---------------------------------------------------------------------------

describe("IP-fallback referral attribution at provision", () => {
  it("attributes a codeless signup to the code opened from the same IP", async () => {
    const referrer = await makeReferrer("BARA-FB01");
    const open = await openLanding("BARA-FB01", "203.0.113.7");
    assert.equal(open.status, 200);

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.7" });

    const referral = await referralOf(user.id);
    assert.ok(referral, "expected a Referral row from the IP fallback");
    assert.equal(referral.referrerId, referrer.id);
    assert.equal(referral.code, "BARA-FB01");
    assert.equal(referral.status, "PENDING");
  });

  it("does NOT attribute when the same IP opened two different codes (ambiguous)", async () => {
    await makeReferrer("BARA-FB02");
    await makeReferrer("BARA-FB03");
    await openLanding("BARA-FB02", "203.0.113.8");
    await openLanding("BARA-FB03", "203.0.113.8");

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.8" });

    assert.equal(await referralOf(user.id), null);
  });

  it("does NOT attribute a signup from an IP with no link opens", async () => {
    await makeReferrer("BARA-FB04");
    await openLanding("BARA-FB04", "203.0.113.9");

    const user = await provision(`sub-fb-${++seq}`, { ip: "198.51.100.1" });

    assert.equal(await referralOf(user.id), null);
  });

  it("an explicit referralCode in the provision body wins over the IP fallback", async () => {
    await makeReferrer("BARA-FB05");
    const explicit = await makeReferrer("BARA-FB06");
    await openLanding("BARA-FB05", "203.0.113.10");

    const user = await provision(`sub-fb-${++seq}`, {
      ip: "203.0.113.10",
      referralCode: "BARA-FB06",
    });

    const referral = await referralOf(user.id);
    assert.ok(referral);
    assert.equal(referral.referrerId, explicit.id);
    assert.equal(referral.code, "BARA-FB06");
  });

  it("does NOT attribute from a stale link open (outside the fallback window)", async () => {
    await makeReferrer("BARA-FB07");
    await openLanding("BARA-FB07", "203.0.113.11");
    // Age the open past the window.
    await prisma.linkOpen.updateMany({
      where: { code: "BARA-FB07" },
      data: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    });

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.11" });

    assert.equal(await referralOf(user.id), null);
  });

  it("does NOT attribute when the IP is suspiciously hot (too many opens)", async () => {
    await makeReferrer("BARA-FB08");
    for (let i = 0; i < 12; i++) {
      await openLanding("BARA-FB08", "203.0.113.12");
    }

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.12" });

    assert.equal(await referralOf(user.id), null);
  });

  it("an existing user re-signing in is never fallback-attributed", async () => {
    await makeReferrer("BARA-FB09");
    const sub = `sub-fb-${++seq}`;
    const user = await provision(sub); // organic first signup, no opens yet

    await openLanding("BARA-FB09", "203.0.113.13");
    const again = await provision(sub, { ip: "203.0.113.13" });

    assert.equal(again.id, user.id);
    assert.equal(await referralOf(user.id), null);
  });
});

// ---------------------------------------------------------------------------
// 2. Seeded races no longer block late manual redemption
// ---------------------------------------------------------------------------

describe("POST /referrals/redeem already_raced guard", () => {
  async function completedRaceFor(userId, { seedId }) {
    seq += 1;
    if (seedId) {
      await prisma.raceSeed.create({
        data: {
          id: seedId,
          kind: "TEST_FALLBACK",
          name: `Seed ${seq}`,
          targetSteps: 10000,
          cadence: "DAILY",
        },
      });
    }
    return prisma.race.create({
      data: {
        name: `Race ${seq}`,
        targetSteps: 10000,
        status: "COMPLETED",
        seedId,
        participants: {
          create: [
            { userId, status: "ACCEPTED", placement: 5, totalSteps: 4000 },
          ],
        },
      },
    });
  }

  it("allows redemption when the user's only completed races are SEEDED (auto-enroll)", async () => {
    const referrer = await makeReferrer("BARA-FB10");
    const { user, token } = await createTestUser({});
    await completedRaceFor(user.id, { seedId: "seed-daily-10k" });

    const res = await request(getBaseUrl(), "POST", "/referrals/redeem", {
      token,
      body: { referralCode: "BARA-FB10" },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.attributed, true);

    const referral = await referralOf(user.id);
    assert.ok(referral);
    assert.equal(referral.referrerId, referrer.id);
  });

  it("still rejects with already_raced after a completed race the user chose (seedId null)", async () => {
    await makeReferrer("BARA-FB11");
    const { user, token } = await createTestUser({});
    await completedRaceFor(user.id, { seedId: null });

    const res = await request(getBaseUrl(), "POST", "/referrals/redeem", {
      token,
      body: { referralCode: "BARA-FB11" },
    });
    const body = await res.json();
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "already_raced");

    assert.equal(await referralOf(user.id), null);
  });
});
