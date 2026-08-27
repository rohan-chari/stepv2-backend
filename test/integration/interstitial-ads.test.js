const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { after, before, beforeEach, describe, test } = require("node:test");

const {
  prisma,
  cleanDatabase,
  disconnectDatabase,
  startServer,
  createTestUser,
  request,
} = require("./setup");

const PLACEMENT = "race_detail_exit";
const OTHER_PLACEMENT = "race_results_exit";
const TIME_ZONE = "America/New_York";

function iso(date) {
  return date.toISOString();
}

function addMs(date, milliseconds) {
  return new Date(date.getTime() + milliseconds);
}

function eligibilityPath({
  placement = PLACEMENT,
  sessionId,
  sessionStartedAt,
  extra = "",
}) {
  const params = new URLSearchParams({
    placement,
    sessionId,
    sessionStartedAt: iso(sessionStartedAt),
  });
  return `/ads/interstitial/eligibility?${params}${extra}`;
}

function authOptions(token, { body, timeZone = TIME_ZONE } = {}) {
  return {
    token,
    body,
    headers: timeZone === null ? {} : { "X-Timezone": timeZone },
  };
}

function permitBody({
  placement = PLACEMENT,
  sessionId,
  sessionStartedAt,
  appVersion = "1.2.3",
  platform = "ios",
}) {
  return {
    placement,
    sessionId,
    sessionStartedAt: iso(sessionStartedAt),
    appVersion,
    platform,
  };
}

function impressionBody({
  eventId = randomUUID(),
  permit,
  placement = permit.placement,
  sessionId = permit.sessionId,
  occurredAt,
  appVersion = "1.2.3",
  platform = "ios",
}) {
  return {
    eventId,
    permitId: permit.id,
    placement,
    sessionId,
    occurredAt: iso(occurredAt),
    appVersion,
    platform,
  };
}

describe("interstitial ad eligibility and presentation permits", () => {
  let clock;
  let server;

  before(async () => {
    clock = new Date("2026-08-26T18:00:00.000Z");
    server = await startServer({ now: () => new Date(clock) });
  });

  beforeEach(async () => {
    await cleanDatabase();
    clock = new Date("2026-08-26T18:00:00.000Z");
  });

  after(async () => {
    await server.close();
    await disconnectDatabase();
  });

  test("new accounts receive acquisition grace, mature accounts receive session grace, and auth is required", async () => {
    const sessionId = randomUUID();
    const sessionStartedAt = addMs(clock, -5 * 60 * 1000);
    const young = await createTestUser({ createdAt: addMs(clock, -60 * 60 * 1000) });

    let response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId, sessionStartedAt }),
      authOptions(young.token),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      eligible: false,
      reason: "acquisition_grace",
      dailyCount: 0,
      dailyLimit: 2,
      nextEligibleAt: iso(addMs(young.user.createdAt, 72 * 60 * 60 * 1000)),
      capDate: "2026-08-26",
      timeZone: TIME_ZONE,
      serverTime: iso(clock),
    });

    const mature = await createTestUser({ createdAt: addMs(clock, -80 * 60 * 60 * 1000) });
    const freshSession = addMs(clock, -30 * 1000);
    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId: randomUUID(), sessionStartedAt: freshSession }),
      authOptions(mature.token),
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).reason, "session_grace");

    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId, sessionStartedAt }),
      { headers: { "X-Timezone": TIME_ZONE } },
    );
    assert.equal(response.status, 401);
  });

  test("eligibility rejects malformed and duplicate query values but fails closed for timezone", async () => {
    const { token } = await createTestUser({ createdAt: addMs(clock, -4 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const started = addMs(clock, -5 * 60 * 1000);
    const malformedPaths = [
      eligibilityPath({ placement: "shop_purchase", sessionId, sessionStartedAt: started }),
      eligibilityPath({ sessionId: "not-a-uuid", sessionStartedAt: started }),
      eligibilityPath({ sessionId, sessionStartedAt: addMs(clock, 1) }),
      eligibilityPath({ sessionId, sessionStartedAt: addMs(clock, -24 * 60 * 60 * 1000 - 1) }),
      eligibilityPath({ sessionId, sessionStartedAt: started, extra: "&unexpected=1" }),
      eligibilityPath({ sessionId, sessionStartedAt: started, extra: `&placement=${PLACEMENT}` }),
    ];

    for (const path of malformedPaths) {
      const response = await request(server.baseUrl, "GET", path, authOptions(token));
      assert.equal(response.status, 400, path);
      assert.deepEqual(await response.json(), {
        error: "Invalid interstitial eligibility request",
        code: "INVALID_INTERSTITIAL_REQUEST",
      });
    }

    for (const timeZone of [null, "Not/A_Zone"] ) {
      const response = await request(
        server.baseUrl,
        "GET",
        eligibilityPath({ sessionId, sessionStartedAt: started }),
        authOptions(token, { timeZone }),
      );
      assert.equal(response.status, 200);
      const payload = await response.json();
      assert.equal(payload.eligible, false);
      assert.equal(payload.reason, "invalid_timezone");
      assert.equal(payload.nextEligibleAt, null);
      assert.equal(payload.capDate, null);
      assert.equal(payload.timeZone, null);
    }
  });

  test("server derives cap dates and next local midnight across the DST fold", async () => {
    clock = new Date("2026-11-01T04:30:00.000Z"); // 00:30 in New York before fallback.
    const { token } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const sessionStartedAt = addMs(clock, -10 * 60 * 1000);

    const permitResponse = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(token, { body: permitBody({ sessionId, sessionStartedAt }) }),
    );
    assert.equal(permitResponse.status, 201);
    const issued = await permitResponse.json();
    assert.equal(issued.capDate, "2026-11-01");
    assert.equal(issued.timeZone, TIME_ZONE);

    const active = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ placement: OTHER_PLACEMENT, sessionId: randomUUID(), sessionStartedAt }),
      authOptions(token),
    );
    assert.equal(active.status, 200);
    const activePayload = await active.json();
    assert.equal(activePayload.reason, "permit_active");
    assert.equal(activePayload.nextEligibleAt, issued.permit.reservationUntil);

    await request(
      server.baseUrl,
      "POST",
      `/ads/interstitial/permits/${issued.permit.id}/cancel`,
      authOptions(token),
    );
  });

  test("timezone changes affect only future permits while issued permits retain their stamps", async () => {
    clock = new Date("2026-08-27T02:00:00.000Z");
    const { token } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const started = addMs(clock, -5 * 60 * 1000);
    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(token, {
        body: permitBody({ sessionId: randomUUID(), sessionStartedAt: started }),
        timeZone: "America/New_York",
      }),
    );
    const firstPayload = await response.json();
    assert.equal(firstPayload.capDate, "2026-08-26");
    await request(
      server.baseUrl,
      "POST",
      `/ads/interstitial/permits/${firstPayload.permit.id}/cancel`,
      authOptions(token),
    );

    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(token, {
        body: permitBody({ sessionId: randomUUID(), sessionStartedAt: started }),
        timeZone: "UTC",
      }),
    );
    assert.equal(response.status, 201);
    const secondPayload = await response.json();
    assert.equal(secondPayload.capDate, "2026-08-27");
    assert.equal(secondPayload.timeZone, "UTC");

    const firstStored = await prisma.interstitialAdPermit.findUnique({
      where: { id: firstPayload.permit.id },
    });
    assert.equal(firstStored.timeZone, "America/New_York");
    assert.equal(firstStored.capDate.toISOString().slice(0, 10), "2026-08-26");
  });

  test("permit admission is atomic and an active reservation blocks all account devices", async () => {
    const secondServer = await startServer({ now: () => new Date(clock) });
    try {
      const { token, user } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
      const sessionStartedAt = addMs(clock, -5 * 60 * 1000);
      const bodies = [
        permitBody({ sessionId: randomUUID(), sessionStartedAt }),
        permitBody({ placement: OTHER_PLACEMENT, sessionId: randomUUID(), sessionStartedAt, platform: "android" }),
      ];
      const responses = await Promise.all([
        request(server.baseUrl, "POST", "/ads/interstitial/permits", authOptions(token, { body: bodies[0] })),
        request(secondServer.baseUrl, "POST", "/ads/interstitial/permits", authOptions(token, { body: bodies[1] })),
      ]);
      assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
      const payloads = await Promise.all(responses.map((response) => response.json()));
      assert.equal(payloads.filter((payload) => payload.eligible && payload.permit).length, 1);
      const loser = payloads.find((payload) => !payload.eligible);
      assert.equal(loser.reason, "permit_active");
      assert.equal(await prisma.interstitialAdPermit.count({ where: { userId: user.id } }), 1);
    } finally {
      await secondServer.close();
    }
  });

  test("permit bodies are exact and bounded", async () => {
    const { token } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const sessionStartedAt = addMs(clock, -5 * 60 * 1000);
    const valid = permitBody({ sessionId, sessionStartedAt });
    const invalidBodies = [
      { ...valid, extra: true },
      { ...valid, placement: "open_all" },
      { ...valid, sessionId: "nope" },
      { ...valid, sessionStartedAt: iso(addMs(clock, 1)) },
      { ...valid, appVersion: "free form version" },
      { ...valid, appVersion: "1" },
      { ...valid, platform: "web" },
    ];
    for (const body of invalidBodies) {
      const response = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/permits",
        authOptions(token, { body }),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Invalid interstitial permit request",
        code: "INVALID_INTERSTITIAL_PERMIT_REQUEST",
      });
    }
  });

  test("confirmed impressions are durable, idempotent, and enforce session then cooldown caps", async () => {
    const { token, user } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const sessionStartedAt = addMs(clock, -5 * 60 * 1000);
    const permitResponse = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(token, { body: permitBody({ sessionId, sessionStartedAt }) }),
    );
    const { permit } = await permitResponse.json();
    const eventId = randomUUID();
    clock = addMs(clock, 12_400);
    const body = impressionBody({ eventId, permit, occurredAt: clock });

    const duplicateResponses = await Promise.all([
      request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/impressions",
        authOptions(token, { body }),
      ),
      request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/impressions",
        authOptions(token, { body }),
      ),
    ]);
    assert.deepEqual(duplicateResponses.map((item) => item.status), [202, 202]);
    const duplicatePayloads = await Promise.all(duplicateResponses.map((item) => item.json()));
    assert.deepEqual(duplicatePayloads.map((item) => item.idempotent).sort(), [false, true]);
    assert.deepEqual(duplicatePayloads.find((item) => !item.idempotent), {
      recorded: true,
      idempotent: false,
      eligible: false,
      reason: "session_cap",
      dailyCount: 1,
      dailyLimit: 2,
      nextEligibleAt: null,
    });

    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(token, { body }),
    );
    assert.equal(response.status, 202);
    assert.equal((await response.json()).idempotent, true);
    assert.equal(await prisma.interstitialAdImpression.count({ where: { userId: user.id } }), 1);

    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId, sessionStartedAt }),
      authOptions(token),
    );
    assert.equal((await response.json()).reason, "session_cap");

    const nextSessionStartedAt = addMs(clock, -2 * 60 * 1000);
    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId: randomUUID(), sessionStartedAt: nextSessionStartedAt }),
      authOptions(token),
    );
    const cooldown = await response.json();
    assert.equal(cooldown.reason, "cooldown");
    assert.equal(cooldown.nextEligibleAt, iso(addMs(clock, 8 * 60 * 60 * 1000)));
  });

  test("a reservation survives showBy, accepts delayed confirmation, and expires only at 24 hours", async () => {
    const { token } = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const sessionStartedAt = addMs(clock, -5 * 60 * 1000);
    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(token, { body: permitBody({ sessionId, sessionStartedAt }) }),
    );
    const { permit } = await response.json();
    const occurredAt = addMs(clock, 30 * 60 * 1000);

    clock = addMs(clock, 2 * 60 * 60 * 1000);
    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      authOptions(token),
    );
    assert.equal((await response.json()).reason, "permit_active");

    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(token, { body: impressionBody({ permit, occurredAt }) }),
    );
    assert.equal(response.status, 202);

    await cleanDatabase();
    clock = new Date("2026-08-26T18:00:00.000Z");
    const other = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(other.token, {
        body: permitBody({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      }),
    );
    const expired = (await response.json()).permit;
    clock = addMs(clock, 24 * 60 * 60 * 1000 + 1);
    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(other.token, {
        body: permitBody({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      }),
    );
    assert.equal(response.status, 201);
    assert.notEqual((await response.json()).permit.id, expired.id);
  });

  test("SDK callback grace is bounded to showBy plus 30 seconds", async () => {
    async function createPermitForNewUser() {
      const account = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
      const sessionId = randomUUID();
      const response = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/permits",
        authOptions(account.token, {
          body: permitBody({ sessionId, sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
        }),
      );
      return { ...account, permit: (await response.json()).permit };
    }

    const accepted = await createPermitForNewUser();
    clock = addMs(new Date(accepted.permit.showBy), 30_000);
    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(accepted.token, {
        body: impressionBody({ permit: accepted.permit, occurredAt: clock }),
      }),
    );
    assert.equal(response.status, 202);

    clock = new Date("2026-08-26T18:00:00.000Z");
    const rejected = await createPermitForNewUser();
    clock = addMs(new Date(rejected.permit.showBy), 30_001);
    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(rejected.token, {
        body: impressionBody({ permit: rejected.permit, occurredAt: clock }),
      }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "Interstitial event conflict",
      code: "INTERSTITIAL_EVENT_CONFLICT",
    });
  });

  test("event and permit collisions are generic and do not enumerate ownership", async () => {
    const accountA = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const accountB = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    async function issue(account) {
      const sessionId = randomUUID();
      const response = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/permits",
        authOptions(account.token, {
          body: permitBody({ sessionId, sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
        }),
      );
      return (await response.json()).permit;
    }
    const permitA = await issue(accountA);
    const permitB = await issue(accountB);
    clock = addMs(clock, 1000);
    const eventId = randomUUID();

    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(accountA.token, {
        body: impressionBody({ eventId, permit: permitA, occurredAt: clock }),
      }),
    );
    assert.equal(response.status, 202);

    const conflicts = [
      authOptions(accountB.token, {
        body: impressionBody({ eventId, permit: permitB, occurredAt: clock }),
      }),
      authOptions(accountB.token, {
        body: impressionBody({ permit: permitA, occurredAt: clock }),
      }),
      authOptions(accountA.token, {
        body: impressionBody({ permit: permitA, occurredAt: clock }),
      }),
    ];
    for (const options of conflicts) {
      response = await request(server.baseUrl, "POST", "/ads/interstitial/impressions", options);
      assert.equal(response.status, 409);
      assert.deepEqual(await response.json(), {
        error: "Interstitial event conflict",
        code: "INTERSTITIAL_EVENT_CONFLICT",
      });
    }

    clock = addMs(clock, 25 * 60 * 60 * 1000);
    const secondPermitResponse = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(accountA.token, {
        body: permitBody({
          sessionId: randomUUID(),
          sessionStartedAt: addMs(clock, -5 * 60 * 1000),
        }),
      }),
    );
    assert.equal(secondPermitResponse.status, 201);
    const secondPermit = (await secondPermitResponse.json()).permit;
    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/impressions",
      authOptions(accountA.token, {
        body: impressionBody({ eventId, permit: secondPermit, occurredAt: clock }),
      }),
    );
    assert.equal(response.status, 409);
  });

  test("impression bodies and cancel permit IDs are strictly validated; cancellation is owner-scoped and idempotent", async () => {
    const account = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const other = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    let response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(account.token, {
        body: permitBody({ sessionId, sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      }),
    );
    const { permit } = await response.json();
    const valid = impressionBody({ permit, occurredAt: addMs(clock, 1000) });
    const invalidBodies = [
      { ...valid, extra: true },
      { ...valid, eventId: "not-uuid" },
      { ...valid, permitId: "not-uuid" },
      { ...valid, placement: "open_all" },
      { ...valid, occurredAt: iso(addMs(clock, 2 * 60 * 1000 + 1)) },
      { ...valid, occurredAt: iso(addMs(clock, -24 * 60 * 60 * 1000 - 1)) },
      { ...valid, appVersion: "version one" },
      { ...valid, platform: "web" },
    ];
    for (const body of invalidBodies) {
      response = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/impressions",
        authOptions(account.token, { body }),
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Invalid interstitial impression",
        code: "INVALID_INTERSTITIAL_IMPRESSION",
      });
    }

    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits/not-a-uuid/cancel",
      authOptions(account.token),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "Invalid interstitial permit id",
      code: "INVALID_INTERSTITIAL_PERMIT_ID",
    });

    for (const token of [other.token, account.token, account.token]) {
      response = await request(
        server.baseUrl,
        "POST",
        `/ads/interstitial/permits/${permit.id}/cancel`,
        authOptions(token),
      );
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { cancelled: true });
    }

    response = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(account.token, {
        body: permitBody({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      }),
    );
    assert.equal(response.status, 201);
  });

  test("cancellation and confirmation serialize to exactly one terminal permit state", async () => {
    const account = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });
    const sessionId = randomUUID();
    const issued = await request(
      server.baseUrl,
      "POST",
      "/ads/interstitial/permits",
      authOptions(account.token, {
        body: permitBody({
          sessionId,
          sessionStartedAt: addMs(clock, -5 * 60 * 1000),
        }),
      }),
    );
    const { permit } = await issued.json();
    clock = addMs(clock, 1000);
    const [cancelled, confirmed] = await Promise.all([
      request(
        server.baseUrl,
        "POST",
        `/ads/interstitial/permits/${permit.id}/cancel`,
        authOptions(account.token),
      ),
      request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/impressions",
        authOptions(account.token, {
          body: impressionBody({ permit, occurredAt: clock }),
        }),
      ),
    ]);
    assert.equal(cancelled.status, 202);
    assert.ok([202, 409].includes(confirmed.status));

    const stored = await prisma.interstitialAdPermit.findUnique({
      where: { id: permit.id },
    });
    assert.notEqual(Boolean(stored.cancelledAt), Boolean(stored.confirmedAt));
    assert.equal(
      await prisma.interstitialAdImpression.count({ where: { permitId: permit.id } }),
      stored.confirmedAt ? 1 : 0,
    );
  });

  test("daily cap combines two confirmed impressions while rolling cooldown survives a local date change", async () => {
    clock = new Date("2026-08-26T19:50:00.000Z"); // 15:50 New York.
    const account = await createTestUser({ createdAt: addMs(clock, -10 * 24 * 60 * 60 * 1000) });

    async function issueAndConfirm() {
      const sessionId = randomUUID();
      const started = addMs(clock, -5 * 60 * 1000);
      const issued = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/permits",
        authOptions(account.token, { body: permitBody({ sessionId, sessionStartedAt: started }) }),
      );
      assert.equal(issued.status, 201);
      const { permit } = await issued.json();
      clock = addMs(clock, 1000);
      const confirmed = await request(
        server.baseUrl,
        "POST",
        "/ads/interstitial/impressions",
        authOptions(account.token, { body: impressionBody({ permit, occurredAt: clock }) }),
      );
      assert.equal(confirmed.status, 202);
    }

    await issueAndConfirm();
    clock = addMs(clock, 8 * 60 * 60 * 1000 + 1000);
    await issueAndConfirm();
    clock = addMs(clock, 60 * 1000);

    let response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      authOptions(account.token),
    );
    let payload = await response.json();
    assert.equal(payload.reason, "daily_cap");
    assert.equal(payload.dailyCount, 2);
    assert.equal(payload.nextEligibleAt, "2026-08-27T04:00:00.000Z");

    clock = new Date("2026-08-27T04:01:00.000Z");
    response = await request(
      server.baseUrl,
      "GET",
      eligibilityPath({ sessionId: randomUUID(), sessionStartedAt: addMs(clock, -5 * 60 * 1000) }),
      authOptions(account.token),
    );
    payload = await response.json();
    assert.equal(payload.reason, "cooldown");
    assert.ok(new Date(payload.nextEligibleAt) > clock);
  });

  test("existing unauthenticated rewarded SSV verification endpoint remains reachable", async () => {
    const response = await request(server.baseUrl, "GET", "/ads/ssv?foo=bar");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, reason: "missing_params" });
  });

  test("activation ingestion accepts only the bounded interstitial and Race Detail analytics vocabulary", async () => {
    const { user, token } = await createTestUser();
    const names = [
      "interstitial_opportunity",
      "interstitial_skipped",
      "interstitial_show_attempted",
      "interstitial_load_succeeded",
      "interstitial_load_failed",
      "interstitial_dismissed",
      "interstitial_show_failed",
      "race_detail_visit_started",
      "race_detail_visit_ended",
      "race_detail_back_exit",
      "race_detail_exit_eligible",
    ];
    const interstitialContext = {
      placement: "race_detail_exit",
      reason: "not_ready",
      result: "back_exit",
    };
    const raceVisitContext = {
      entry_surface: "tournament",
      exit_kind: "back",
      scope_result: "active_accepted",
      dwell_bucket: "10_59s",
    };
    let response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      authOptions(token, {
        body: {
          events: names.map((name) => ({
            id: randomUUID(),
            name,
            context: name.startsWith("interstitial_")
              ? interstitialContext
              : raceVisitContext,
            appVersion: "1.2.3",
            platform: "ios",
            timestamp: iso(clock),
          })),
        },
      }),
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: names.length, inserted: names.length });
    assert.equal(
      await prisma.activationEvent.count({ where: { userId: user.id } }),
      names.length,
    );

    response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      authOptions(token, {
        body: {
          events: [{
            id: randomUUID(),
            name: "race_detail_visit_ended",
            context: { race_id: randomUUID() },
            appVersion: "1.2.3",
            platform: "ios",
            timestamp: iso(clock),
          }],
        },
      }),
    );
    assert.equal(response.status, 400);
    response = await request(
      server.baseUrl,
      "POST",
      "/analytics/activation-events",
      authOptions(token, {
        body: {
          events: [{
            id: randomUUID(),
            name: "interstitial_opportunity",
            context: { ad_unit_id: "private" },
            appVersion: "1.2.3",
            platform: "ios",
            timestamp: iso(clock),
          }],
        },
      }),
    );
    assert.equal(response.status, 400);
  });
});
