const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");
const { defaultConfig } = require("../../src/modules/economy/balanceConfig.defaults");

// Batch 2026-08-08 item 1 — `discardPrices` as an OPTIONAL balance-config key.
//
// The spec requires this key to follow the `teamOnlyTypes` precedent exactly:
// validated only when present, NO SCHEMA_VERSION bump (stored rows predate the
// key and a bump hard-rejects them), and a SOFT_BOUNDS entry. The failure this
// guards against is the known "partial row blocks apply" incident, where a
// stored config written before a key existed makes every later save/apply fail.

let server;
let nextAppleId = 0;

const ADMIN_EMAIL =
  process.env.ADMIN_EMAILS?.split(",")[0]?.trim() || "admin@test.com";

async function createUser() {
  const appleId = `apple-dp-${++nextAppleId}-${Date.now()}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  return { userId: body.user.id, token: body.sessionToken };
}

async function createAdmin() {
  const admin = await createUser();
  await prisma.user.update({
    where: { id: admin.userId },
    data: { email: ADMIN_EMAIL },
  });
  return admin;
}

function get(token) {
  return request(server.baseUrl, "GET", "/admin/balance-config", { token });
}

function put(token, body) {
  return request(server.baseUrl, "PUT", "/admin/balance-config", { token, body });
}

describe("batch 2026-08-08 item 1 — discardPrices balance-config key", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await prisma.balanceConfig.deleteMany({});
    nextAppleId = 0;
  });

  it("is served with the shipped defaults when no config row exists", async () => {
    const admin = await createAdmin();
    const res = await get(admin.token);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.config.discardPrices, {
      COMMON: 2,
      UNCOMMON: 5,
      RARE: 10,
    });
  });

  it("publishes a soft bound for the key so the admin UI can warn before saving", async () => {
    const admin = await createAdmin();
    const body = await (await get(admin.token)).json();
    assert.deepEqual(body.bounds["discardPrices.*"], [0, 50]);
  });

  it("round-trips an edited price through the admin save path", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.discardPrices = { COMMON: 3, UNCOMMON: 7, RARE: 12 };

    const saved = await put(admin.token, { expectedVersion: null, config });
    assert.equal(saved.status, 201);
    assert.deepEqual((await saved.json()).config.discardPrices, {
      COMMON: 3,
      UNCOMMON: 7,
      RARE: 12,
    });

    // And it survives a fresh read, not just the save's echo.
    const reread = await (await get(admin.token)).json();
    assert.deepEqual(reread.config.discardPrices, {
      COMMON: 3,
      UNCOMMON: 7,
      RARE: 12,
    });
  });

  // ── the partial-row failure mode ─────────────────────────────────────────

  it("a STORED CONFIG LACKING the key still saves, reads, and inherits the code defaults", async () => {
    const admin = await createAdmin();

    // Exactly what a row written before this key existed looks like.
    const legacy = defaultConfig();
    delete legacy.discardPrices;

    const saved = await put(admin.token, {
      expectedVersion: null,
      config: legacy,
      note: "pre-discardPrices row",
    });
    assert.equal(
      saved.status,
      201,
      "an absent optional key must not fail validation"
    );

    // The stored row genuinely lacks the key...
    const row = await prisma.balanceConfig.findFirst({
      orderBy: { version: "desc" },
    });
    assert.equal(
      row.config.discardPrices,
      undefined,
      "the PARTIAL row is what must be persisted (defaults are never frozen in)"
    );

    // ...but the merged config the game runs on has the code defaults.
    const merged = await (await get(admin.token)).json();
    assert.deepEqual(merged.config.discardPrices, {
      COMMON: 2,
      UNCOMMON: 5,
      RARE: 10,
    });
  });

  it("a later save on top of a key-less stored row is NOT blocked (partial-row-blocks-apply regression)", async () => {
    const admin = await createAdmin();
    const legacy = defaultConfig();
    delete legacy.discardPrices;
    const first = await put(admin.token, { expectedVersion: null, config: legacy });
    const v1 = (await first.json()).version;

    // The incident shape: the NEXT edit, made against the partial row, fails.
    const next = defaultConfig();
    delete next.discardPrices;
    next.typeWeights = { ...next.typeWeights, RED_CARD: 0.4 };
    const second = await put(admin.token, { expectedVersion: v1, config: next });
    assert.equal(second.status, 201, "a partial stored row must not block later saves");
  });

  it("SCHEMA_VERSION is unchanged, so a row stored at the old version still validates", async () => {
    const admin = await createAdmin();
    const legacy = defaultConfig();
    delete legacy.discardPrices;
    // schemaVersion is whatever shipped before this batch; adding an optional
    // key must not have bumped it.
    assert.equal(legacy.schemaVersion, 1);
    const res = await put(admin.token, { expectedVersion: null, config: legacy });
    assert.equal(res.status, 201);
  });

  // ── validation, only when present ────────────────────────────────────────

  it("rejects a negative price (a coin DRAIN on a button labelled discard)", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.discardPrices = { COMMON: -1, UNCOMMON: 5, RARE: 10 };
    const res = await put(admin.token, { expectedVersion: null, config });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.ok(
      body.errors.some((e) => e.path === "discardPrices.COMMON"),
      `expected a discardPrices.COMMON error, got ${JSON.stringify(body.errors)}`
    );
  });

  it("rejects a fractional price and an unknown rarity key", async () => {
    const admin = await createAdmin();

    const fractional = defaultConfig();
    fractional.discardPrices = { COMMON: 2.5, UNCOMMON: 5, RARE: 10 };
    assert.equal((await put(admin.token, { expectedVersion: null, config: fractional })).status, 400);

    const badKey = defaultConfig();
    badKey.discardPrices = { COMMON: 2, LEGENDARY: 99 };
    const res = await put(admin.token, { expectedVersion: null, config: badKey });
    assert.equal(res.status, 400);
  });

  it("rejects a non-object discardPrices", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.discardPrices = [2, 5, 10];
    assert.equal((await put(admin.token, { expectedVersion: null, config })).status, 400);
  });

  it("a price past the soft bound is 422 and succeeds with the explicit ack", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.discardPrices = { COMMON: 2, UNCOMMON: 5, RARE: 999 };

    const warned = await put(admin.token, { expectedVersion: null, config });
    assert.equal(warned.status, 422);
    const body = await warned.json();
    assert.equal(body.error, "bound_warnings");
    assert.ok(
      body.warnings.some((w) => String(w.path).startsWith("discardPrices")),
      `expected a discardPrices warning, got ${JSON.stringify(body.warnings)}`
    );

    const acked = await put(admin.token, {
      expectedVersion: null,
      config,
      acknowledgeBoundWarnings: true,
    });
    assert.equal(acked.status, 201);
  });

  // ── end-to-end: the key actually drives the payout ───────────────────────

  it("an admin price edit changes what a real discard pays on the wire", async () => {
    const admin = await createAdmin();
    const config = defaultConfig();
    config.discardPrices = { COMMON: 2, UNCOMMON: 5, RARE: 25 };
    assert.equal(
      (await put(admin.token, { expectedVersion: null, config })).status,
      201
    );

    const alice = await createUser();
    const bob = await createUser();
    const createRes = await request(server.baseUrl, "POST", "/races", {
      body: {
        name: "Discard price e2e",
        targetSteps: 500000,
        maxDurationDays: 7,
        powerupsEnabled: true,
        powerupStepInterval: 5000,
      },
      token: alice.token,
    });
    const raceId = (await createRes.json()).race.id;
    await request(server.baseUrl, "POST", `/races/${raceId}/invite`, {
      body: { inviteeIds: [bob.userId] },
      token: alice.token,
    });
    await request(server.baseUrl, "PUT", `/races/${raceId}/respond`, {
      body: { accept: true },
      token: bob.token,
    });
    await request(server.baseUrl, "POST", `/races/${raceId}/start`, {
      token: alice.token,
    });

    const participant = await prisma.raceParticipant.findFirst({
      where: { raceId, userId: alice.userId },
    });
    const powerup = await prisma.racePowerup.create({
      data: {
        raceId,
        participantId: participant.id,
        userId: alice.userId,
        type: "PROTEIN_SHAKE",
        rarity: "RARE",
        status: "HELD",
        earnedAtSteps: 5000,
      },
    });

    // The 5s balance-config cache TTL means a just-saved price may not be live
    // in this process yet; poll briefly rather than sleeping a flat 5s.
    let body = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await request(
        server.baseUrl,
        "POST",
        `/races/${raceId}/powerups/${powerup.id}/discard`,
        { token: alice.token }
      );
      body = await res.json();
      if (body.coinsAwarded === 25) break;
      // Not live yet — recreate the powerup and retry after the TTL lapses.
      await new Promise((r) => setTimeout(r, 2100));
      await prisma.racePowerup.update({
        where: { id: powerup.id },
        data: { status: "HELD" },
      });
    }
    assert.equal(body.coinsAwarded, 25, "the stored price must drive the award");
    assert.equal(body.capRemaining, 15, "cap 40 minus the 25 just paid");
  });

  // ── the script path ──────────────────────────────────────────────────────

  it("balance:apply runs against a stored config that LACKS the key", async () => {
    const admin = await createAdmin();
    const legacy = defaultConfig();
    delete legacy.discardPrices;
    assert.equal(
      (await put(admin.token, { expectedVersion: null, config: legacy })).status,
      201
    );

    // Dry run (the script's default) — it must evaluate the stored partial row
    // without throwing or reporting validation errors.
    const out = execFileSync(
      process.execPath,
      [path.join(__dirname, "../../scripts/balance-apply.js")],
      {
        cwd: path.join(__dirname, "../.."),
        env: {
          ...process.env,
          DATABASE_URL:
            "postgresql://rohan@localhost:5432/steps-tracker-integration",
        },
        encoding: "utf8",
      }
    );
    assert.doesNotMatch(
      out,
      /invalid_config|is not a valid|must be a non-negative/,
      `balance-apply reported validation errors against a key-less row:\n${out}`
    );
  });
});
