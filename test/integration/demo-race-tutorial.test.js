const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { prisma, cleanDatabase, request, getSharedServer } = require("./setup");

// Demo race tutorial — backend half
// (stepv2-frontend/docs/demo-race-tutorial-requirements.md §6.3, §10 items 25-26).
//
// The demo race is entirely client-side: no endpoint, no table, no migration.
// The ONLY production change is widening ALLOWED_EVENT_NAMES with the three
// demo funnel events. These tests prove the widening through the real HTTP
// endpoint (never by importing the validator) and prove it is additive: an
// older client's payload, which knows nothing of the new names, still succeeds.
//
// Real HTTP, real DB, real handler chain. Never against prod: `npm run
// test:integration` pins DATABASE_URL to the local steps-tracker-integration DB.
describe("demo race tutorial analytics", () => {
  let server;
  let nextAppleId = 0;

  const DEMO_EVENT_NAMES = ["demo_box_opened", "demo_powerup_used", "demo_won"];
  const ADMIN_EMAIL =
    process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  async function signUp() {
    const appleId = `apple-demo-race-${++nextAppleId}-${Date.now()}`;
    const res = await request(server.baseUrl, "POST", "/auth/apple", {
      body: { identityToken: appleId },
    });
    assert.equal(res.status, 200, "signup should succeed");
    const body = await res.json();
    return { userId: body.user.id, token: body.sessionToken };
  }

  function activationEvent(overrides = {}) {
    return {
      id: `evt-${Math.random().toString(36).slice(2)}-${Date.now()}`,
      name: "home_reached",
      appVersion: "2.1.0",
      platform: "ios",
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  function postEvents(token, events) {
    return request(server.baseUrl, "POST", "/analytics/activation-events", {
      token,
      body: { events },
    });
  }

  // ── §10.25 — the three new names are accepted and persist ─────────────────

  it("25. accepts a batch of all three demo event names and persists them", async () => {
    const { token, userId } = await signUp();

    const res = await postEvents(
      token,
      DEMO_EVENT_NAMES.map((name) => activationEvent({ name }))
    );

    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 3, inserted: 3 });

    const stored = await prisma.activationEvent.findMany({ where: { userId } });
    assert.deepEqual(
      stored.map((row) => row.name).sort(),
      [...DEMO_EVENT_NAMES].sort(),
      "all three demo events persist as rows"
    );
  });

  it("25b. each demo event name is accepted on its own", async () => {
    for (const name of DEMO_EVENT_NAMES) {
      const { token, userId } = await signUp();
      const res = await postEvents(token, [activationEvent({ name })]);
      assert.equal(res.status, 202, `${name} should be accepted`);
      assert.deepEqual(await res.json(), { accepted: 1, inserted: 1 }, name);
      const stored = await prisma.activationEvent.findMany({ where: { userId } });
      assert.equal(stored.length, 1, name);
      assert.equal(stored[0].name, name);
    }
  });

  it("25c. the demo funnel rides the existing tutorial_* names with source=onboarding", async () => {
    const { token, userId } = await signUp();

    const res = await postEvents(token, [
      activationEvent({ name: "tutorial_opened", context: { source: "onboarding" } }),
      activationEvent({ name: "demo_box_opened", context: { source: "onboarding" } }),
      activationEvent({ name: "demo_powerup_used", context: { source: "onboarding" } }),
      activationEvent({ name: "demo_won", context: { source: "onboarding" } }),
      activationEvent({
        name: "tutorial_completed",
        context: { source: "onboarding" },
      }),
    ]);

    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 5, inserted: 5 });

    const stored = await prisma.activationEvent.findMany({ where: { userId } });
    assert.equal(stored.length, 5);
    for (const row of stored) {
      assert.deepEqual(row.context, { source: "onboarding" }, row.name);
    }
  });

  // ── §10.26 — the widening is additive: an older client still works ────────

  it("26. an older client's payload, with none of the new names, still succeeds", async () => {
    const { token, userId } = await signUp();

    // Exactly what a frozen pre-demo build sends: the tutorial_* funnel with
    // source=profile, plus an older appVersion. No demo_* name anywhere.
    const res = await postEvents(token, [
      activationEvent({
        name: "tutorial_opened",
        appVersion: "1.9.0",
        context: { source: "profile" },
      }),
      activationEvent({
        name: "tutorial_skipped",
        appVersion: "1.9.0",
        context: { source: "profile", step: "3" },
      }),
      activationEvent({ name: "home_reached", appVersion: "1.9.0", platform: "android" }),
    ]);

    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { accepted: 3, inserted: 3 });

    const stored = await prisma.activationEvent.findMany({ where: { userId } });
    assert.deepEqual(
      stored.map((row) => row.name).sort(),
      ["home_reached", "tutorial_opened", "tutorial_skipped"]
    );
    const skipped = stored.find((row) => row.name === "tutorial_skipped");
    assert.deepEqual(skipped.context, { source: "profile", step: "3" });
  });

  // ── Verification of behavior the spec's compat story depends on ───────────
  // (existing behavior — asserted here, not changed)

  it("26b. a NEWER app against an OLDER backend loses only the unknown names, not the batch", async () => {
    const { token, userId } = await signUp();

    // Stand-in for names this backend does not know yet. Proves the soft-drop
    // path: unknown names vanish, the rest of the batch still lands with a 202.
    const res = await postEvents(token, [
      activationEvent({ name: "tutorial_opened", context: { source: "onboarding" } }),
      activationEvent({ name: "demo_not_yet_deployed_event" }),
      activationEvent({ name: "demo_won", context: { source: "onboarding" } }),
      activationEvent({ name: "another_future_event" }),
      activationEvent({ name: "tutorial_completed", context: { source: "onboarding" } }),
    ]);

    assert.equal(res.status, 202, "unknown names must not poison the batch");
    assert.deepEqual(await res.json(), { accepted: 3, inserted: 3 });

    const stored = await prisma.activationEvent.findMany({ where: { userId } });
    assert.deepEqual(
      stored.map((row) => row.name).sort(),
      ["demo_won", "tutorial_completed", "tutorial_opened"].sort()
    );
  });

  it("26c. `step` is a decimal STRING 1..10; a bare number is rejected", async () => {
    // The demo sends beat indices 1..9 as strings (§5.9).
    for (const step of ["1", "9", "10"]) {
      const { token } = await signUp();
      const ok = await postEvents(token, [
        activationEvent({ name: "tutorial_skipped", context: { source: "onboarding", step } }),
      ]);
      assert.equal(ok.status, 202, `step "${step}" should be accepted`);
      assert.deepEqual(await ok.json(), { accepted: 1, inserted: 1 });
    }

    const { token } = await signUp();
    const numeric = await postEvents(token, [
      activationEvent({ name: "tutorial_skipped", context: { source: "onboarding", step: 3 } }),
    ]);
    assert.equal(numeric.status, 400, "a bare number must be rejected");

    for (const bad of ["0", "11", "-1", "2.5", "03", ""]) {
      const user = await signUp();
      const res = await postEvents(user.token, [
        activationEvent({
          name: "tutorial_skipped",
          context: { source: "onboarding", step: bad },
        }),
      ]);
      assert.equal(res.status, 400, `step ${JSON.stringify(bad)} must be rejected`);
    }
  });

  it("26d. a demo event with a disallowed context value still 400s (no new context keys)", async () => {
    const { token } = await signUp();
    const res = await postEvents(token, [
      activationEvent({ name: "demo_won", context: { source: "banana" } }),
    ]);
    assert.equal(res.status, 400);
  });

  // ── Admin funnel wiring (owner-approved follow-up) ────────────────────────
  // The demo drop-off must read as a curve on the admin stats screen, not be
  // SQL-only. Asserted through the real GET /admin/stats, never by importing
  // getAdminStats.

  async function signUpAdmin() {
    const admin = await signUp();
    await prisma.user.update({
      where: { id: admin.userId },
      data: { email: ADMIN_EMAIL },
    });
    return admin;
  }

  function stats(adminToken) {
    return request(server.baseUrl, "GET", "/admin/stats", { token: adminToken });
  }

  it("27. the demo stages appear in the admin funnel, in demo sequence order", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    const session = "session-demo-full-run";
    const post = await postEvents(token, [
      activationEvent({ name: "onboarding_started", onboardingSessionId: session }),
      activationEvent({ name: "daily_intro_viewed", onboardingSessionId: session }),
      activationEvent({
        name: "tutorial_opened",
        onboardingSessionId: session,
        context: { source: "onboarding" },
      }),
      // Two box opens in one run must still count the session ONCE.
      activationEvent({ name: "demo_box_opened", onboardingSessionId: session }),
      activationEvent({ name: "demo_box_opened", onboardingSessionId: session }),
      activationEvent({ name: "demo_powerup_used", onboardingSessionId: session }),
      activationEvent({ name: "demo_won", onboardingSessionId: session }),
      activationEvent({
        name: "tutorial_completed",
        onboardingSessionId: session,
        context: { source: "onboarding" },
      }),
      activationEvent({ name: "home_reached", onboardingSessionId: session }),
    ]);
    assert.equal(post.status, 202);

    const res = await stats(admin.token);
    assert.equal(res.status, 200);
    const { stats: body } = await res.json();
    const ios = body.onboardingFunnel.byPlatform.ios;

    for (const stage of [
      "tutorial_opened",
      "demo_box_opened",
      "demo_powerup_used",
      "demo_won",
      "tutorial_completed",
    ]) {
      assert.equal(ios[stage], 1, `${stage} counts the session once`);
    }

    // The demo block sits between the race intro and home, which is where the
    // onboarding step actually runs — so the bars read as one continuous curve.
    assert.deepEqual(Object.keys(ios), [
      "onboarding_started",
      "health_cta_tapped",
      "health_granted",
      "health_escaped",
      "health_probe_inconclusive",
      "daily_intro_viewed",
      "tutorial_opened",
      "demo_box_opened",
      "demo_powerup_used",
      "demo_won",
      "tutorial_completed",
      "home_reached",
    ]);
  });

  it("27b. a demo drop-off renders as a real curve (opened > box > powerup > won)", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    // Three sessions that bail at successively later beats.
    const events = [];
    const reach = { s1: 1, s2: 2, s3: 4 };
    const ladder = [
      "tutorial_opened",
      "demo_box_opened",
      "demo_powerup_used",
      "demo_won",
    ];
    for (const [session, depth] of Object.entries(reach)) {
      // Every session must be anchored by an onboarding_started, or the funnel
      // correctly refuses to count it at all (see 28).
      events.push(
        activationEvent({
          name: "onboarding_started",
          onboardingSessionId: `sess-${session}`,
        })
      );
      for (const name of ladder.slice(0, depth)) {
        events.push(activationEvent({ name, onboardingSessionId: `sess-${session}` }));
      }
    }
    assert.equal((await postEvents(token, events)).status, 202);

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    assert.equal(ios.tutorial_opened, 3);
    assert.equal(ios.demo_box_opened, 2);
    assert.equal(ios.demo_powerup_used, 1);
    assert.equal(ios.demo_won, 1);
    assert.equal(ios.tutorial_completed, 0);
    // Monotonically non-increasing — the property that makes it a funnel.
    const curve = ladder.map((k) => ios[k]);
    for (let i = 1; i < curve.length; i++) {
      assert.ok(curve[i] <= curve[i - 1], "funnel must not increase down the spine");
    }
  });

  it("27c. tutorial_skipped is NOT an ordered stage (it is an exit, not a step)", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({
            name: "tutorial_skipped",
            onboardingSessionId: "sess-skip",
            context: { source: "onboarding", step: "3" },
          }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    assert.equal(
      Object.prototype.hasOwnProperty.call(ios, "tutorial_skipped"),
      false,
      "a skip is an exit; putting it in the ordered stages would distort the curve"
    );
    // It is not lost — it still surfaces by name in the activation section,
    // which is unfiltered by the funnel stage list.
    assert.ok(body.activationFunnel, "activation section still present");
  });

  it("27d. the pre-existing funnel stages are unchanged (additive-only)", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({
            name: "onboarding_started",
            onboardingSessionId: "sess-legacy",
          }),
          activationEvent({
            name: "health_result",
            onboardingSessionId: "sess-legacy",
            context: { result: "granted" },
          }),
          activationEvent({
            name: "home_reached",
            onboardingSessionId: "sess-legacy",
          }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const funnel = body.onboardingFunnel;
    assert.equal(funnel.windowDays, 7, "pinned contract key unchanged");
    assert.ok(funnel.byPlatform.android, "android bucket still always present");
    const ios = funnel.byPlatform.ios;
    assert.equal(ios.onboarding_started, 1);
    assert.equal(ios.health_granted, 1);
    assert.equal(ios.home_reached, 1);
    // New stages default to 0 rather than being absent, same as every other
    // stage, so a funnel with no demo data still renders a stable set of rows.
    assert.equal(ios.demo_box_opened, 0);
    assert.equal(ios.demo_won, 0);
  });

  // KNOWN LIMITATION — still present after anchoring, and this is precisely
  // why anchoring alone is not the fix. The funnel groups by stage name and
  // never reads context->>'source'. Because onboardingSessionId is minted once
  // per INSTALL rather than per onboarding run, a settings replay reuses the
  // install's id — an id that DOES carry an onboarding_started, so the anchor
  // admits it. Only the client-side per-RUN session id closes this.
  it("27e. KNOWN LIMITATION: a settings-tutorial replay counts into the onboarding funnel", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    // One install that SKIPPED the demo, then later replayed the spotlight
    // tutorial from Profile -> Settings and finished it there. The id is shared
    // because it is minted per INSTALL, so the real onboarding run's
    // onboarding_started anchors the replay's events too.
    const install = "sess-install-shared";
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({
            name: "onboarding_started",
            onboardingSessionId: install,
          }),
          activationEvent({
            name: "tutorial_opened",
            onboardingSessionId: install,
            context: { source: "onboarding" },
          }),
          activationEvent({
            name: "tutorial_skipped",
            onboardingSessionId: install,
            context: { source: "onboarding", step: "1" },
          }),
          activationEvent({
            name: "tutorial_completed",
            onboardingSessionId: install,
            context: { source: "profile" },
          }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    assert.equal(
      ios.tutorial_completed,
      1,
      "the profile-sourced completion is counted as an onboarding completion — " +
        "tutorial_opened/tutorial_completed are OVER-COUNTED by settings replays"
    );
    // The demo_* stages are NOT affected: only the demo emits them, so they are
    // always source:onboarding and always trustworthy.
    assert.equal(ios.demo_won, 0);
  });

  // ── Funnel anchoring (owner decision: fix at the root, part 2) ────────────
  //
  // The aggregation counted DISTINCT session ids PER STAGE INDEPENDENTLY, with
  // nothing tying a stage back to a session that actually started onboarding.
  // So an orphan session — one with no onboarding_started at all — still
  // contributed +1 to whatever stages it happened to emit.
  //
  // NEITHER HALF OF THE ROOT FIX WORKS ALONE:
  //   - per-run session ids alone (frontend): a replay mints a FRESH id, which
  //     has no onboarding_started, and unanchored it is still counted.
  //   - anchoring alone (here): under today's per-INSTALL ids a replay shares
  //     the install's id, which DOES have an onboarding_started, so it is still
  //     counted.
  // Only both together exclude the replay. These tests cover the anchor half.

  // Backdate rows so the 7d/30d window boundaries can be exercised. The events
  // are still POSTed through the real endpoint and every assertion still comes
  // from GET /admin/stats — only the clock is fixtured, which no amount of
  // HTTP can do (the endpoint always stamps created_at = now()).
  async function backdate(sessionId, days, name) {
    await prisma.activationEvent.updateMany({
      where: { onboardingSessionId: sessionId, ...(name ? { name } : {}) },
      data: { createdAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000) },
    });
  }

  it("28. an orphan session (no onboarding_started) contributes to NO stage", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    // Replay-shaped: the settings tutorial opened and completed, with a fresh
    // per-run session id and no onboarding_started anywhere.
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({
            name: "tutorial_opened",
            onboardingSessionId: "sess-replay-orphan",
            context: { source: "profile" },
          }),
          activationEvent({
            name: "tutorial_completed",
            onboardingSessionId: "sess-replay-orphan",
            context: { source: "profile" },
          }),
          // Even a core stage from an orphan session must not count.
          activationEvent({
            name: "home_reached",
            onboardingSessionId: "sess-replay-orphan",
          }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    assert.equal(ios.tutorial_opened, 0, "orphan replay must not be counted");
    assert.equal(ios.tutorial_completed, 0, "orphan replay must not be counted");
    assert.equal(ios.home_reached, 0, "anchoring applies to EVERY stage");
  });

  it("28b. a legitimate onboarding session still counts every stage it reached", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    const session = "sess-anchored-real";
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({ name: "onboarding_started", onboardingSessionId: session }),
          activationEvent({ name: "health_cta_tapped", onboardingSessionId: session }),
          activationEvent({
            name: "health_result",
            onboardingSessionId: session,
            context: { result: "granted" },
          }),
          activationEvent({ name: "daily_intro_viewed", onboardingSessionId: session }),
          activationEvent({ name: "tutorial_opened", onboardingSessionId: session }),
          activationEvent({ name: "demo_box_opened", onboardingSessionId: session }),
          activationEvent({ name: "demo_powerup_used", onboardingSessionId: session }),
          activationEvent({ name: "demo_won", onboardingSessionId: session }),
          activationEvent({ name: "tutorial_completed", onboardingSessionId: session }),
          activationEvent({ name: "home_reached", onboardingSessionId: session }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    for (const stage of [
      "onboarding_started",
      "health_cta_tapped",
      "health_granted",
      "daily_intro_viewed",
      "tutorial_opened",
      "demo_box_opened",
      "demo_powerup_used",
      "demo_won",
      "tutorial_completed",
      "home_reached",
    ]) {
      assert.equal(ios[stage], 1, `${stage} must survive anchoring`);
    }
  });

  it("28c. WINDOW SEMANTICS: a start outside 7d still anchors a stage inside 7d", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    // The exact case a per-column anchor would break: onboarding began 9 days
    // ago (outside the 7d window) and the user reached home 3 days ago (inside
    // it). The 7d column must still count home_reached — otherwise anchoring
    // would silently shrink an existing, legitimate number.
    const session = "sess-straddles-7d";
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({ name: "onboarding_started", onboardingSessionId: session }),
          activationEvent({ name: "home_reached", onboardingSessionId: session }),
        ])
      ).status,
      202
    );
    await backdate(session, 9, "onboarding_started");
    await backdate(session, 3, "home_reached");

    const { stats: body } = await (await stats(admin.token)).json();
    const sevenDay = body.onboardingFunnel.byPlatform.ios;
    const thirtyDay = body.onboardingFunnel.byPlatformLast30Days.ios;

    assert.equal(
      sevenDay.home_reached,
      1,
      "an in-progress funnel must not be dropped because its START predates the column window"
    );
    assert.equal(
      sevenDay.onboarding_started,
      0,
      "the start itself is outside 7d, so it does not count in the 7d column"
    );
    assert.equal(thirtyDay.onboarding_started, 1);
    assert.equal(thirtyDay.home_reached, 1);
  });

  it("28d. the anchor reaches back further than the reported windows", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    // Start 200 days ago — far outside even the 30d reporting window — with a
    // stage event today. The anchor is deliberately unbounded in time, so this
    // still counts. A time-bounded anchor would drop it and quietly change the
    // meaning of already-collected data for long-lived installs.
    const session = "sess-ancient-start";
    assert.equal(
      (
        await postEvents(token, [
          activationEvent({ name: "onboarding_started", onboardingSessionId: session }),
          activationEvent({ name: "home_reached", onboardingSessionId: session }),
        ])
      ).status,
      202
    );
    await backdate(session, 200, "onboarding_started");

    const { stats: body } = await (await stats(admin.token)).json();
    assert.equal(body.onboardingFunnel.byPlatform.ios.home_reached, 1);
  });

  it("28e. a NULL session id is still excluded, as before", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();
    assert.equal(
      (await postEvents(token, [activationEvent({ name: "home_reached" })])).status,
      202
    );
    const { stats: body } = await (await stats(admin.token)).json();
    assert.equal(body.onboardingFunnel.byPlatform.ios.home_reached, 0);
  });

  it("28f. anchoring is per-session, not global: one orphan cannot ride another session's start", async () => {
    const admin = await signUpAdmin();
    const { token } = await signUp();

    assert.equal(
      (
        await postEvents(token, [
          // A real session that started and reached home.
          activationEvent({
            name: "onboarding_started",
            onboardingSessionId: "sess-real-neighbour",
          }),
          activationEvent({
            name: "home_reached",
            onboardingSessionId: "sess-real-neighbour",
          }),
          // A different, orphan session that only reached home.
          activationEvent({
            name: "home_reached",
            onboardingSessionId: "sess-orphan-neighbour",
          }),
        ])
      ).status,
      202
    );

    const { stats: body } = await (await stats(admin.token)).json();
    const ios = body.onboardingFunnel.byPlatform.ios;
    assert.equal(ios.onboarding_started, 1);
    assert.equal(ios.home_reached, 1, "only the anchored session's home_reached counts");
  });
});
