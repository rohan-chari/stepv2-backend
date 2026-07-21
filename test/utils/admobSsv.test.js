const assert = require("node:assert/strict");
const test = require("node:test");
const { generateKeyPairSync, sign } = require("node:crypto");

const {
  verifySsvSignature,
  parseSsvQuery,
  buildKeyFetcher,
} = require("../../src/modules/economy/admobSsv");

// Real AdMob SSV callbacks are GET requests whose query string ends with
// &signature=<base64url DER ECDSA-SHA256>&key_id=<id>; the signed message is
// everything before "&signature=". We mint our own P-256 keypair and sign the
// same way Google does.
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = "3335741209";

const MESSAGE =
  "ad_network=5450213213286189855&ad_unit=903827490&custom_data=2026-07-06" +
  "&reward_amount=1&reward_item=extra_spin&timestamp=1770000000000" +
  "&transaction_id=txn-abc-123&user_id=user-1";

function signedQuery(message = MESSAGE, keyId = KEY_ID, priv = privateKey) {
  const sig = sign("sha256", Buffer.from(message, "utf8"), priv);
  return `${message}&signature=${sig.toString("base64url")}&key_id=${keyId}`;
}

const KEYS = [{ keyId: KEY_ID, pem: PEM }];

test("verifySsvSignature: accepts a correctly signed query", () => {
  assert.equal(verifySsvSignature({ rawQuery: signedQuery(), keys: KEYS }), true);
});

test("verifySsvSignature: rejects a tampered message", () => {
  const tampered = signedQuery().replace("user_id=user-1", "user_id=user-2");
  assert.equal(verifySsvSignature({ rawQuery: tampered, keys: KEYS }), false);
});

test("verifySsvSignature: rejects an unknown key_id", () => {
  assert.equal(
    verifySsvSignature({ rawQuery: signedQuery(MESSAGE, "999"), keys: KEYS }),
    false
  );
});

test("verifySsvSignature: rejects a signature from the wrong key", () => {
  const other = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const forged = signedQuery(MESSAGE, KEY_ID, other.privateKey);
  assert.equal(verifySsvSignature({ rawQuery: forged, keys: KEYS }), false);
});

test("verifySsvSignature: rejects when signature param is missing", () => {
  assert.equal(
    verifySsvSignature({ rawQuery: `${MESSAGE}&key_id=${KEY_ID}`, keys: KEYS }),
    false
  );
});

test("verifySsvSignature: numeric keyId in the key set still matches", () => {
  const keys = [{ keyId: Number(KEY_ID), pem: PEM }];
  assert.equal(verifySsvSignature({ rawQuery: signedQuery(), keys }), true);
});

test("parseSsvQuery: decodes params into a plain object", () => {
  const params = parseSsvQuery(signedQuery());
  assert.equal(params.user_id, "user-1");
  assert.equal(params.transaction_id, "txn-abc-123");
  assert.equal(params.custom_data, "2026-07-06");
  assert.equal(params.key_id, KEY_ID);
});

test("buildKeyFetcher: fetches Google's key set and caches it", async () => {
  let fetches = 0;
  const fetchImpl = async () => {
    fetches++;
    return {
      ok: true,
      json: async () => ({ keys: [{ keyId: 123, pem: PEM, base64: "x" }] }),
    };
  };
  const fetchKeys = buildKeyFetcher({ fetchImpl, cacheTtlMs: 60_000 });
  const first = await fetchKeys();
  const second = await fetchKeys();
  assert.equal(fetches, 1);
  assert.deepEqual(first, second);
  assert.equal(String(first[0].keyId), "123");
});

test("buildKeyFetcher: throws on a non-OK response", async () => {
  const fetchKeys = buildKeyFetcher({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(() => fetchKeys());
});

// Google signs the URL-DECODED parameter string, but sends reserved chars
// percent-encoded on the wire. Bare-date custom_data never hit this (raw ==
// decoded); "coins:<date>" arrives as coins%3A<date> and must still verify.
test("verifySsvSignature: verifies the decoded message when the wire query is percent-encoded", () => {
  const decodedMessage = MESSAGE.replace(
    "custom_data=2026-07-06",
    "custom_data=coins:2026-07-07"
  );
  const sig = sign("sha256", Buffer.from(decodedMessage, "utf8"), privateKey);
  const wireQuery =
    decodedMessage.replace("coins:2026-07-07", "coins%3A2026-07-07") +
    `&signature=${sig.toString("base64url")}&key_id=${KEY_ID}`;

  assert.equal(verifySsvSignature({ rawQuery: wireQuery, keys: KEYS }), true);
});

test("verifySsvSignature: still rejects tampering on a percent-encoded query", () => {
  const decodedMessage = MESSAGE.replace(
    "custom_data=2026-07-06",
    "custom_data=coins:2026-07-07"
  );
  const sig = sign("sha256", Buffer.from(decodedMessage, "utf8"), privateKey);
  const wireQuery =
    decodedMessage
      .replace("coins:2026-07-07", "coins%3A2026-07-07")
      .replace("user_id=user-1", "user_id=user-2") +
    `&signature=${sig.toString("base64url")}&key_id=${KEY_ID}`;

  assert.equal(verifySsvSignature({ rawQuery: wireQuery, keys: KEYS }), false);
});
