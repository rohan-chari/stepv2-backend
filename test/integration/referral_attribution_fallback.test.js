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
const { describe, it, before, after, beforeEach } = require("node:test");

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
// 1b. `referrals.source` stamping (invite-code onboarding spec, part B)
//
// Every write path stamps which MECHANISM attributed the referral. This is not
// only observability: redeemReferralCode reads `source` to decide whether an
// explicit manual redeem may replace a weak tier-2 IP guess, so a wrong stamp
// would either strand a real referral or let a manual redeem overwrite a
// trustworthy attribution.
// ---------------------------------------------------------------------------

describe("referrals.source stamping at provision", () => {
  it("stamps source=provision_body when the code arrived in the provision body", async () => {
    await makeReferrer("BARA-SRC1");

    const user = await provision(`sub-fb-${++seq}`, {
      referralCode: "BARA-SRC1",
    });

    const referral = await referralOf(user.id);
    assert.ok(referral, "expected a Referral row from the body code");
    assert.equal(referral.source, "provision_body");
  });

  it("stamps source=ip_fallback_exact for a tier-1 exact-IP match", async () => {
    await makeReferrer("BARA-SRC2");
    await openLanding("BARA-SRC2", "203.0.113.20");

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.20" });

    const referral = await referralOf(user.id);
    assert.ok(referral, "expected a Referral row from the exact-IP fallback");
    assert.equal(referral.source, "ip_fallback_exact");
  });

  it("leaves no referral at all for an organic signup (nothing to stamp)", async () => {
    const user = await provision(`sub-fb-${++seq}`, { ip: "198.51.100.77" });

    assert.equal(await referralOf(user.id), null);
  });
});

// ---------------------------------------------------------------------------
// 1c. Tier 2 — coarse-network (prefix) fallback matching (spec part D)
//
// The exact-IP match breaks whenever the landing page and the app egress from
// different addresses on the same network (IPv4<->IPv6, Wi-Fi<->cellular, NAT
// churn). Tier 2 matches on a hashed network prefix (IPv4 /24, IPv6 /64)
// instead — but ONLY when tier 1 found zero opens, and only when the env
// switch is on (it ships OFF; see the spec's abuse-cost note).
// ---------------------------------------------------------------------------

describe("IP-fallback tier 2 (network prefix)", () => {
  // The tier-2 knobs are read per call (not at module load) precisely so this
  // suite can exercise both postures against the shared in-process server.
  function setNetEnv({ enabled, maxOpens } = {}) {
    if (enabled === undefined) delete process.env.REFERRAL_IP_FALLBACK_NET_ENABLED;
    else process.env.REFERRAL_IP_FALLBACK_NET_ENABLED = enabled;
    if (maxOpens === undefined) delete process.env.REFERRAL_IP_FALLBACK_NET_MAX_OPENS;
    else process.env.REFERRAL_IP_FALLBACK_NET_MAX_OPENS = maxOpens;
  }

  beforeEach(() => setNetEnv());
  after(() => setNetEnv());

  it("is DEAD by default (env unset) while tier 1 still lives", async () => {
    // Default prod posture: the same-/24 pair must NOT attribute...
    await makeReferrer("BARA-NET1");
    await openLanding("BARA-NET1", "203.0.113.31");
    const netUser = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.32" });
    assert.equal(
      await referralOf(netUser.id),
      null,
      "tier 2 must not attribute while REFERRAL_IP_FALLBACK_NET_ENABLED is unset"
    );

    // ...but an EXACT-IP pair still does (tier 1 is unaffected by the switch).
    await makeReferrer("BARA-NET2");
    await openLanding("BARA-NET2", "203.0.113.35");
    const exactUser = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.35" });
    const exact = await referralOf(exactUser.id);
    assert.ok(exact, "tier 1 must keep working with tier 2 disabled");
    assert.equal(exact.source, "ip_fallback_exact");
  });

  it("attributes a same-/24 IPv4 open with source=ip_fallback_net when enabled", async () => {
    setNetEnv({ enabled: "1" });
    const referrer = await makeReferrer("BARA-NET3");
    await openLanding("BARA-NET3", "203.0.113.41");

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.42" });

    const referral = await referralOf(user.id);
    assert.ok(referral, "expected a tier-2 Referral row");
    assert.equal(referral.referrerId, referrer.id);
    assert.equal(referral.code, "BARA-NET3");
    assert.equal(referral.status, "PENDING");
    assert.equal(referral.source, "ip_fallback_net");
  });

  it("matches a same-/64 IPv6 pair written in different (compressed vs expanded) forms", async () => {
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NET4");
    await openLanding("BARA-NET4", "2600:1:2:3:aaaa::1");

    // Same /64, but spelled with zero-padded hextets and a different suffix.
    const user = await provision(`sub-fb-${++seq}`, {
      ip: "2600:0001:0002:0003:bbbb::2",
    });

    const referral = await referralOf(user.id);
    assert.ok(referral, "expanded and compressed IPv6 /64s must agree");
    assert.equal(referral.source, "ip_fallback_net");
  });

  it("hashes an IPv4-mapped IPv6 open as the v4 /24, not a /64 of the mapped range", async () => {
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NET5");
    await openLanding("BARA-NET5", "::ffff:203.0.113.51");

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.52" });

    const referral = await referralOf(user.id);
    assert.ok(referral, "::ffff: v4-mapped must normalize to the v4 /24");
    assert.equal(referral.source, "ip_fallback_net");
  });

  it("does NOT attribute across different /24s", async () => {
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NET6");
    await openLanding("BARA-NET6", "203.0.113.61");

    const user = await provision(`sub-fb-${++seq}`, { ip: "198.51.100.61" });

    assert.equal(await referralOf(user.id), null);
  });

  it("does NOT fall through to tier 2 when tier 1 found opens but declined", async () => {
    // The guard is "tier 1 found ZERO opens", not "tier 1 returned no code".
    // Proving that needs a case where tier 2 WOULD have resolved: 12 opens of
    // ONE code from the exact signup IP. Tier 1 declines (hot IP, >10), and the
    // raised tier-2 cap means a fall-through would happily attribute all 12
    // same-/24 opens to that single code. It must stay unattributed.
    setNetEnv({ enabled: "1", maxOpens: "50" });
    await makeReferrer("BARA-NET7");
    for (let i = 0; i < 12; i++) {
      await openLanding("BARA-NET7", "203.0.113.71");
    }

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.71" });

    assert.equal(
      await referralOf(user.id),
      null,
      "an exact-IP decline is stronger evidence of a shared network — never widen it"
    );
  });

  it("does NOT attribute when the same /24 opened two different codes (ambiguous)", async () => {
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NET8");
    await makeReferrer("BARA-NET9");
    await openLanding("BARA-NET8", "203.0.113.81");
    await openLanding("BARA-NET9", "203.0.113.82");

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.83" });

    assert.equal(await referralOf(user.id), null);
  });

  it("does NOT attribute when the /24 is hot (more opens than the tier-2 cap)", async () => {
    setNetEnv({ enabled: "1" }); // default cap = 10 opens
    await makeReferrer("BARA-NETA");
    for (let i = 1; i <= 12; i++) {
      await openLanding("BARA-NETA", `203.0.113.${100 + i}`);
    }

    const user = await provision(`sub-fb-${++seq}`, { ip: "203.0.113.200" });

    assert.equal(await referralOf(user.id), null);
  });

  it("skips tier 2 entirely when the signup's own net hash is null (legacy-NULL row hazard)", async () => {
    // A `where: { ipNetHash: null }` lookup would match EVERY pre-deploy
    // link_opens row and attribute off whatever single code happened to be
    // there. An unparseable X-Forwarded-For yields a null net hash, so this is
    // the exact shape that would trip it.
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NETB");
    await openLanding("BARA-NETB", "203.0.113.210");
    // Simulate a legacy row: written before ip_net_hash existed.
    await prisma.linkOpen.updateMany({
      where: { code: "BARA-NETB" },
      data: { ipNetHash: null },
    });

    const user = await provision(`sub-fb-${++seq}`, { ip: "not-an-ip-at-all" });

    assert.equal(
      await referralOf(user.id),
      null,
      "a null net hash must never be used as a match key"
    );
  });

  it("a body code still wins over BOTH tiers", async () => {
    setNetEnv({ enabled: "1" });
    await makeReferrer("BARA-NETC");
    const explicit = await makeReferrer("BARA-NETD");
    await openLanding("BARA-NETC", "203.0.113.221");

    const user = await provision(`sub-fb-${++seq}`, {
      ip: "203.0.113.222",
      referralCode: "BARA-NETD",
    });

    const referral = await referralOf(user.id);
    assert.ok(referral);
    assert.equal(referral.referrerId, explicit.id);
    assert.equal(referral.source, "provision_body");
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
    // Any seeded race proves the property (the guard counts `seedId != null`),
    // so use a fixture id of our own. "seed-daily-10k" is the id of a REAL row
    // inserted by the add_race_seeds migration, and this helper CREATES the
    // seed it names — so naming the canonical one collides on the primary key
    // and the test can never pass on a properly migrated database. The
    // beforeEach only clears kind "TEST_FALLBACK", which never matches that row.
    await completedRaceFor(user.id, { seedId: `seed-fallback-test-${Date.now()}` });

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
