const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");

const { createApp } = require("../../src/app");

// AdMob server-side verification callback:
//   GET /ads/ssv?...&signature=...&key_id=...   (unauthenticated; Google calls it)
// Signature is verified against Google's public keys, then an AdRewardGrant is
// minted (idempotent on transaction_id). Mirrors the DI pattern of the other
// HTTP route tests: signature verification and the grant command are stubbed.

async function startServer(dependencies = {}) {
  const app = createApp(dependencies);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  };
}

const QUERY =
  "ad_network=54502&ad_unit=903827490&custom_data=2026-07-06" +
  "&reward_amount=1&reward_item=extra_spin&timestamp=1770000000000" +
  "&transaction_id=txn-1&user_id=user-me&signature=c2ln&key_id=123";

test("GET /ads/ssv verifies the signature and mints a grant", async () => {
  const grants = [];
  const verified = [];
  const server = await startServer({
    verifySsv: async (rawQuery) => {
      verified.push(rawQuery);
      return true;
    },
    grantAdReward: async (args) => {
      grants.push(args);
      return { granted: true };
    },
  });
  try {
    const res = await fetch(`${server.baseUrl}/ads/ssv?${QUERY}`);
    assert.equal(res.status, 200);
    assert.equal(verified.length, 1);
    assert.equal(verified[0], QUERY);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].userId, "user-me");
    assert.equal(grants[0].transactionId, "txn-1");
    assert.equal(grants[0].adUnit, "903827490");
    assert.equal(grants[0].customData, "2026-07-06");
    assert.match(grants[0].serverDate, /^\d{4}-\d{2}-\d{2}$/);
  } finally {
    await server.close();
  }
});

test("GET /ads/ssv rejects a bad signature with 403 and mints nothing", async () => {
  const grants = [];
  const server = await startServer({
    verifySsv: async () => false,
    grantAdReward: async (args) => {
      grants.push(args);
      return { granted: true };
    },
  });
  try {
    const res = await fetch(`${server.baseUrl}/ads/ssv?${QUERY}`);
    assert.equal(res.status, 403);
    assert.equal(grants.length, 0);
  } finally {
    await server.close();
  }
});

test("GET /ads/ssv returns 200 on duplicate grants (Google retries)", async () => {
  const server = await startServer({
    verifySsv: async () => true,
    grantAdReward: async () => ({ granted: false, reason: "duplicate" }),
  });
  try {
    const res = await fetch(`${server.baseUrl}/ads/ssv?${QUERY}`);
    assert.equal(res.status, 200);
  } finally {
    await server.close();
  }
});

// AdMob's console "verify callback URL" step pings the bare URL and needs a
// 200; a paramless ping must acknowledge without minting anything.
test("GET /ads/ssv without transaction_id/user_id acks 200 and mints nothing", async () => {
  const grants = [];
  const server = await startServer({
    verifySsv: async () => true,
    grantAdReward: async (args) => {
      grants.push(args);
      return { granted: true };
    },
  });
  try {
    const res = await fetch(`${server.baseUrl}/ads/ssv?foo=bar`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(grants.length, 0);
  } finally {
    await server.close();
  }
});
