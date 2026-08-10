// Backend half of the invite-code onboarding spec
// (docs/invite-code-onboarding-requirements.md, v6).
//
// Real HTTP, real DB, real handler chain — `npm run test:integration` pins
// DATABASE_URL at the local steps-tracker-integration database.
//
// What is under test here is the CONTRACT the Flutter onboarding step codes
// against, so every assertion is on the response a client actually receives:
//
//   * POST /referrals/redeem — unchanged wire shape, now source-stamped, plus
//     the one new rule that lets explicit user intent pre-empt a weak tier-2
//     IP guess (and ONLY that);
//   * the exact `{attributed:false, reason}` set the client's copy map keys on;
//   * `referredByCode` on the auth payloads, INCLUDING the freshness case that
//     decides whether the step is shown at all on first launch;
//   * featureFlags.onboardingInviteCodeEnabled (the kill switch);
//   * the ten new activation-event names.

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

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function makeReferrer(code) {
  seq += 1;
  return prisma.user.create({
    data: {
      appleId: `apple-invite-${seq}-${Date.now()}`,
      email: `invite-${seq}-${Date.now()}@example.com`,
      displayName: `Inviter ${seq}`,
      referralCode: code,
    },
  });
}

// Provision a brand-new Apple user through the real route (the shared server's
// Apple verifier stub treats the identityToken as the sub).
async function provision(sub, { referralCode } = {}) {
  const res = await request(getBaseUrl(), "POST", "/auth/apple", {
    body: { identityToken: sub, referralCode },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return { user: body.user, token: body.sessionToken };
}

async function redeem(token, referralCode) {
  const res = await request(getBaseUrl(), "POST", "/referrals/redeem", {
    token,
    body: { referralCode },
  });
  assert.equal(res.status, 200, "redeem always answers 200, never an error code");
  return res.json();
}

before(async () => {
  await getSharedServer();
});

beforeEach(async () => {
  await cleanDatabase();
  // Neither link_opens nor app_settings are in cleanDatabase's TRUNCATE list.
  // Clear link_opens wholesale (this suite owns none it wants to keep) but
  // touch ONLY the one app_settings key this suite writes — the integration DB
  // is shared and a blanket wipe would yank state out from under other suites.
  await prisma.linkOpen.deleteMany({});
  await prisma.appSetting.deleteMany({
    where: { key: "onboardingInviteCodeEnabled" },
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 1b — redeem pre-emption guard
//
// Why this exists: refereeSubHash is unique and redeem answers
// `already_attributed` off it, so a WRONG tier-2 attribution would be permanent
// — the genuine inviter lost forever, and the onboarding step cheerfully
// telling the user "You're already connected to your inviter!" about a
// stranger. Explicit intent must therefore beat an IP guess. It must beat
// NOTHING else: provision_body and ip_fallback_exact are trustworthy, and a
// non-PENDING referral has already paid out.
// ---------------------------------------------------------------------------

describe("POST /referrals/redeem pre-emption of a tier-2 IP guess", () => {
  // Build the "already attributed" precondition through the REAL provision
  // path (body code -> recordReferral -> a genuine referral row), then restate
  // only the two columns the rule reads. Creating the row by hand would need
  // the internal sub-hash helper and would prove nothing about the real writer.
  async function attributedUser({ source, status = "PENDING" }) {
    seq += 1;
    const wrong = await makeReferrer(`BARA-WRNG${seq}`);
    const { user, token } = await provision(`sub-preempt-${seq}`, {
      referralCode: wrong.referralCode,
    });
    const existing = await prisma.referral.findUnique({
      where: { refereeId: user.id },
    });
    assert.ok(existing, "precondition: the body code must have attributed");
    await prisma.referral.update({
      where: { id: existing.id },
      data: { source, status },
    });
    return { user, token, wrong };
  }

  it("REPLACES a PENDING ip_fallback_net referral with the manually entered one", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "ip_fallback_net",
    });
    const right = await makeReferrer("BARA-RIGHT1");

    const body = await redeem(token, "BARA-RIGHT1");
    assert.equal(body.attributed, true);

    // Exactly one referral row survives, and it points at the real inviter.
    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows.length, 1, "replace must not leave a duplicate row");
    assert.equal(rows[0].referrerId, right.id);
    assert.equal(rows[0].code, "BARA-RIGHT1");
    assert.equal(rows[0].source, "redeem");
    assert.equal(rows[0].status, "PENDING");
    assert.notEqual(rows[0].referrerId, wrong.id);

    // The users-row mirror follows the replacement.
    const refreshed = await prisma.user.findUnique({ where: { id: user.id } });
    assert.equal(refreshed.referredByCode, "BARA-RIGHT1");
  });

  it("REFUSES to replace a provision_body attribution", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "provision_body",
    });
    await makeReferrer("BARA-RIGHT2");

    const body = await redeem(token, "BARA-RIGHT2");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "already_attributed");

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrerId, wrong.id);
    assert.equal(rows[0].source, "provision_body");
  });

  it("REFUSES to replace an ip_fallback_exact attribution", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "ip_fallback_exact",
    });
    await makeReferrer("BARA-RIGHT3");

    const body = await redeem(token, "BARA-RIGHT3");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "already_attributed");

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows[0].referrerId, wrong.id);
  });

  it("REFUSES to replace an ip_fallback_net referral that is no longer PENDING", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "ip_fallback_net",
      status: "QUALIFIED",
    });
    await makeReferrer("BARA-RIGHT4");

    const body = await redeem(token, "BARA-RIGHT4");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "already_attributed");

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows[0].referrerId, wrong.id);
    assert.equal(rows[0].status, "QUALIFIED");
  });

  it("REFUSES to replace a legacy referral with a NULL source (pre-tracking)", async () => {
    const { user, token, wrong } = await attributedUser({ source: null });
    await makeReferrer("BARA-RIGHT5");

    const body = await redeem(token, "BARA-RIGHT5");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "already_attributed");

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows[0].referrerId, wrong.id);
  });

  it("still replaces a PENDING ip_fallback_net row when tier 2 is switched back OFF", async () => {
    // The rule keys off the STAMP on the existing row, not on current config —
    // rows minted while tier 2 was on must stay pre-emptible after it is
    // switched off (which is exactly when someone notices the bad match).
    delete process.env.REFERRAL_IP_FALLBACK_NET_ENABLED;
    const { user, token } = await attributedUser({ source: "ip_fallback_net" });
    const right = await makeReferrer("BARA-RIGHT6");

    const body = await redeem(token, "BARA-RIGHT6");
    assert.equal(body.attributed, true);

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrerId, right.id);
    assert.equal(rows[0].source, "redeem");
  });

  it("does not let the replacement bypass the self-referral guard", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "ip_fallback_net",
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { referralCode: "BARA-SELF1" },
    });

    const body = await redeem(token, "BARA-SELF1");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "self_referral");

    // The original row must survive a refused replacement.
    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrerId, wrong.id);
    assert.equal(rows[0].source, "ip_fallback_net");
  });

  it("does not let the replacement bypass the unknown-code guard", async () => {
    const { user, token, wrong } = await attributedUser({
      source: "ip_fallback_net",
    });

    const body = await redeem(token, "BARA-NOPE9");
    assert.equal(body.attributed, false);
    assert.equal(body.reason, "unknown_code");

    const rows = await prisma.referral.findMany({ where: { refereeId: user.id } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].referrerId, wrong.id);
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 2 — redeem stamps `source`, and the reason set is frozen
// ---------------------------------------------------------------------------

describe("POST /referrals/redeem source stamping + reason contract", () => {
  it("stamps source=redeem on a successful manual redemption", async () => {
    const referrer = await makeReferrer("BARA-RDM1");
    const { user, token } = await createTestUser({});

    const body = await redeem(token, "BARA-RDM1");
    assert.deepEqual(body, { attributed: true });

    const referral = await prisma.referral.findUnique({
      where: { refereeId: user.id },
    });
    assert.ok(referral);
    assert.equal(referral.referrerId, referrer.id);
    assert.equal(referral.source, "redeem");
  });

  // The frontend copy map (referral_screen.dart:169-183 and the new onboarding
  // step) switches on these exact strings. Changing one silently degrades the
  // user to a generic error, so pin the whole set.
  it("returns the exact {attributed:false, reason} body for every rejection", async () => {
    // invalid_code — empty/garbage that never normalizes to a code
    {
      const { token } = await createTestUser({});
      assert.deepEqual(await redeem(token, ""), {
        attributed: false,
        reason: "invalid_code",
      });
    }

    // unknown_code — well-formed but nobody owns it
    {
      const { token } = await createTestUser({});
      assert.deepEqual(await redeem(token, "BARA-ZZZZ"), {
        attributed: false,
        reason: "unknown_code",
      });
    }

    // self_referral
    {
      const { token } = await createTestUser({ referralCode: "BARA-SELF2" });
      assert.deepEqual(await redeem(token, "BARA-SELF2"), {
        attributed: false,
        reason: "self_referral",
      });
    }

    // already_attributed — a trustworthy existing source, attributed for real
    // at provision so the guard is exercised against a genuine row.
    {
      await makeReferrer("BARA-RDM2");
      await makeReferrer("BARA-RDM3");
      const { token } = await provision(`sub-inv-${++seq}`, {
        referralCode: "BARA-RDM3",
      });
      assert.deepEqual(await redeem(token, "BARA-RDM2"), {
        attributed: false,
        reason: "already_attributed",
      });
    }

    // already_raced — a COMPLETED race the user chose to join (seedId null)
    {
      await makeReferrer("BARA-RDM4");
      const { user, token } = await createTestUser({});
      await prisma.race.create({
        data: {
          name: `Chosen race ${++seq}`,
          targetSteps: 10000,
          status: "COMPLETED",
          seedId: null,
          participants: {
            create: [{ userId: user.id, status: "ACCEPTED", totalSteps: 4000 }],
          },
        },
      });
      assert.deepEqual(await redeem(token, "BARA-RDM4"), {
        attributed: false,
        reason: "already_raced",
      });
    }

    // no_identity — a user row carrying neither appleId nor googleSub. Not
    // reachable by signing up (every provider path sets one), so strip the
    // identity after the session token is issued; requireAuth resolves the
    // token by user id, so the request still authenticates.
    {
      await makeReferrer("BARA-RDM5");
      const { user, token } = await createTestUser({});
      await prisma.user.update({
        where: { id: user.id },
        data: { appleId: null, googleSub: null },
      });
      assert.deepEqual(await redeem(token, "BARA-RDM5"), {
        attributed: false,
        reason: "no_identity",
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 3 — `referredByCode` on the auth payloads, incl. FRESHNESS
//
// The onboarding step is hidden on server truth: `referredByCode != null`.
// ensure*User returns the in-memory user object built BEFORE recordReferral
// runs its `user.update({referredByCode})`, so without the fix a
// just-attributed signup serializes null and the step is shown to exactly the
// users who were successfully attributed. The negative case matters just as
// much: recordReferral declines SILENTLY (unknown code, review account,
// self-referral, swallowed P2002), and reporting a declined code as attributed
// would hide the step from the users this feature exists to catch.
// ---------------------------------------------------------------------------

describe("referredByCode on the auth payload", () => {
  it("is null for an organic signup, on the provision response and /auth/me", async () => {
    const { user, token } = await provision(`sub-inv-${++seq}`);
    assert.equal(user.referredByCode, null);

    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal((await me.json()).user.referredByCode, null);
  });

  it("is NON-NULL in the very same provision response that attributed the user", async () => {
    await makeReferrer("BARA-FRESH1");

    const { user, token } = await provision(`sub-inv-${++seq}`, {
      referralCode: "BARA-FRESH1",
    });

    assert.equal(
      user.referredByCode,
      "BARA-FRESH1",
      "a just-attributed provision must not serialize a stale null"
    );

    // And it is real server state, not just a decorated response.
    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal((await me.json()).user.referredByCode, "BARA-FRESH1");
  });

  it("stays NULL when the body code was silently DECLINED (unknown code)", async () => {
    const { user, token } = await provision(`sub-inv-${++seq}`, {
      referralCode: "BARA-NOSUCH",
    });

    assert.equal(
      user.referredByCode,
      null,
      "an attempted-but-declined code must never be reported as attribution"
    );
    assert.equal(
      await prisma.referral.findUnique({ where: { refereeId: user.id } }),
      null,
      "no referral row should exist for an unknown code"
    );

    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal((await me.json()).user.referredByCode, null);
  });

  it("is present on a RETURNING user's provision response", async () => {
    await makeReferrer("BARA-FRESH2");
    const sub = `sub-inv-${++seq}`;
    await provision(sub, { referralCode: "BARA-FRESH2" });

    const { user } = await provision(sub); // re-sign-in, no body code
    assert.equal(user.referredByCode, "BARA-FRESH2");
  });

  it("reflects a later manual redemption on /auth/me", async () => {
    await makeReferrer("BARA-FRESH3");
    const { user, token } = await provision(`sub-inv-${++seq}`);
    assert.equal(user.referredByCode, null);

    assert.equal((await redeem(token, "BARA-FRESH3")).attributed, true);

    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal((await me.json()).user.referredByCode, "BARA-FRESH3");
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 4 — the kill switch
// ---------------------------------------------------------------------------

describe("featureFlags.onboardingInviteCodeEnabled", () => {
  it("defaults to TRUE on the provision response and /auth/me", async () => {
    const { user, token } = await provision(`sub-inv-${++seq}`);
    assert.equal(user.featureFlags.onboardingInviteCodeEnabled, true);

    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal(
      (await me.json()).user.featureFlags.onboardingInviteCodeEnabled,
      true
    );
  });

  it("is FALSE once the app-setting override is stored", async () => {
    // Flip it the way ops actually does — through the admin endpoint — rather
    // than by writing app_settings directly, which would bypass the in-process
    // flag cache and prove nothing about the real kill-switch path.
    const admin = await provision(`sub-inv-admin-${++seq}`);
    await prisma.user.update({
      where: { id: admin.user.id },
      data: { email: ADMIN_EMAIL },
    });
    const patch = await request(getBaseUrl(), "PATCH", "/admin/settings", {
      token: admin.token,
      body: { onboardingInviteCodeEnabled: false },
    });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).settings.onboardingInviteCodeEnabled, false);

    const { token } = await provision(`sub-inv-${++seq}`);
    const me = await request(getBaseUrl(), "GET", "/auth/me", { token });
    assert.equal(
      (await me.json()).user.featureFlags.onboardingInviteCodeEnabled,
      false
    );

    // Restore: the flag cache is per-process and the integration DB is shared,
    // so leaving it false could leak into a later suite.
    await request(getBaseUrl(), "PATCH", "/admin/settings", {
      token: admin.token,
      body: { onboardingInviteCodeEnabled: true },
    });
  });
});

// ---------------------------------------------------------------------------
// Test-plan item 5 — activation-event name allowlist
//
// Names only. An unknown NAME soft-drops per event; an unknown CONTEXT key
// 400s the whole batch and the client retains it, so one bad event would
// poison every later flush. That is why the part-C outcomes are encoded in the
// name — and why this suite also pins that no context key was added.
// ---------------------------------------------------------------------------

describe("POST /analytics/activation-events allowlist additions", () => {
  const NEW_EVENT_NAMES = [
    "invite_code_step_shown",
    "invite_code_applied",
    "invite_code_skipped",
    "install_attr_deep_link",
    "install_attr_detect_miss",
    "install_attr_read_denied",
    "install_attr_read_no_code",
    "install_attr_code_captured",
    "install_attr_install_referrer",
    "install_attr_error",
  ];

  function eventNamed(name) {
    return {
      id: `${name}-${++seq}-${Date.now()}`,
      name,
      appVersion: "2.1.0+1",
      platform: "ios",
      timestamp: new Date().toISOString(),
    };
  }

  it("accepts and inserts all ten new names", async () => {
    const { user, token } = await createTestUser({});
    const events = NEW_EVENT_NAMES.map(eventNamed);

    const res = await request(
      getBaseUrl(),
      "POST",
      "/analytics/activation-events",
      { token, body: { events } }
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), {
      accepted: NEW_EVENT_NAMES.length,
      inserted: NEW_EVENT_NAMES.length,
    });

    const stored = await prisma.activationEvent.findMany({
      where: { userId: user.id },
      select: { name: true },
    });
    assert.deepEqual(
      stored.map((e) => e.name).sort(),
      [...NEW_EVENT_NAMES].sort()
    );
  });

  it("still soft-drops an unknown name per event without failing the batch", async () => {
    const { user, token } = await createTestUser({});
    const events = [
      eventNamed("invite_code_applied"),
      eventNamed("definitely_not_a_real_event"),
    ];

    const res = await request(
      getBaseUrl(),
      "POST",
      "/analytics/activation-events",
      { token, body: { events } }
    );
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 1, inserted: 1 });

    const stored = await prisma.activationEvent.findMany({
      where: { userId: user.id },
      select: { name: true },
    });
    assert.deepEqual(stored.map((e) => e.name), ["invite_code_applied"]);
  });

  it("keeps rejecting an unknown CONTEXT key with a 400 (no allowlist widening)", async () => {
    const { token } = await createTestUser({});
    const event = eventNamed("invite_code_step_shown");
    event.context = { install_attr_outcome: "read_denied" };

    const res = await request(
      getBaseUrl(),
      "POST",
      "/analytics/activation-events",
      { token, body: { events: [event] } }
    );
    assert.equal(
      res.status,
      400,
      "the part-C outcomes must live in the NAME — no context key was added"
    );
  });
});
