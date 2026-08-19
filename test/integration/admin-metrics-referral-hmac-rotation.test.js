const assert = require("node:assert/strict");
const { describe, it, before, beforeEach, afterEach } = require("node:test");
const {
  cleanDatabase,
  getSharedServer,
  prisma,
} = require("./setup");

const KEYS = [
  "REFERRAL_IP_HMAC_ACTIVE_VERSION",
  "REFERRAL_IP_HMAC_SECRET_V1",
  "REFERRAL_IP_HMAC_SECRET_V2",
  "REFERRAL_IP_HMAC_ENABLED_AT",
  "REFERRAL_IP_FALLBACK_NET_ENABLED",
];
const original = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

describe("Phase A referral HMAC version rotation", () => {
  let server;
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => {
    await cleanDatabase();
    process.env.REFERRAL_IP_HMAC_SECRET_V1 = "rotation-test-secret-version-one-material";
    process.env.REFERRAL_IP_HMAC_SECRET_V2 = "rotation-test-secret-version-two-material";
    process.env.REFERRAL_IP_HMAC_ENABLED_AT = new Date().toISOString();
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });

  async function open(code, ip) {
    const before = await prisma.linkOpen.count({ where: { code } });
    const response = await fetch(`${server.baseUrl}/r/${code}`, {
      headers: { "X-Forwarded-For": ip },
    });
    assert.equal(response.status, 200);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await prisma.linkOpen.count({ where: { code } })) > before) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail("versioned landing write did not complete");
  }

  async function provision(sub, ip) {
    const response = await fetch(`${server.baseUrl}/auth/apple`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
      body: JSON.stringify({ identityToken: sub }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).user;
  }

  it("reads the immediately previous HMAC version during the 48-hour rotation interval", async () => {
    const referrer = await prisma.user.create({
      data: { appleId: "rotation-referrer", referralCode: "BARA-ROT1" },
    });
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    await open("BARA-ROT1", "203.0.113.42");
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "2";

    const user = await provision("rotation-signup", "203.0.113.42");
    const referral = await prisma.referral.findUnique({ where: { refereeId: user.id } });
    assert.equal(referral?.referrerId, referrer.id);
  });

  it("stops reading the previous HMAC version after 48 hours", async () => {
    await prisma.user.create({
      data: { appleId: "expired-rotation-referrer", referralCode: "BARA-ROT2" },
    });
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    await open("BARA-ROT2", "203.0.113.43");
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "2";
    process.env.REFERRAL_IP_HMAC_ENABLED_AT = new Date(
      Date.now() - 49 * 60 * 60 * 1000
    ).toISOString();

    const user = await provision("expired-rotation-signup", "203.0.113.43");
    assert.equal(await prisma.referral.findUnique({ where: { refereeId: user.id } }), null);
  });

  it("dual-reads the previous version's network-prefix hash during rotation", async () => {
    const referrer = await prisma.user.create({
      data: { appleId: "rotation-net-referrer", referralCode: "BARA-ROT3" },
    });
    process.env.REFERRAL_IP_FALLBACK_NET_ENABLED = "true";
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "1";
    await open("BARA-ROT3", "203.0.113.10");
    process.env.REFERRAL_IP_HMAC_ACTIVE_VERSION = "2";

    const user = await provision("rotation-net-signup", "203.0.113.20");
    const referral = await prisma.referral.findUnique({ where: { refereeId: user.id } });
    assert.equal(referral?.referrerId, referrer.id);
    assert.equal(referral?.source, "ip_fallback_net");
  });
});
