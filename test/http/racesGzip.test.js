const assert = require("node:assert/strict");
const test = require("node:test");
const http = require("node:http");
const zlib = require("node:zlib");
const { createApp } = require("../../src/app");

// A >1 KiB /races payload so compression's 1 KiB threshold fires.
const BIG_RESULT = {
  active: Array.from({ length: 40 }, (_, i) => ({
    id: `race-${i}`,
    name: `Race number ${i} with a reasonably long name to add bytes`,
    status: "ACTIVE",
    participantCount: 7,
    slotItems: [],
    payoutTiers: [{ placement: 1, amount: 100 }],
  })),
  pending: [],
  completed: [],
};

function authDep(req, _res, next) {
  req.user = { id: "user-1" };
  req.timeZone = "UTC";
  req.clientFeatures = new Set();
  next();
}

function makeApp() {
  return createApp({ requireAuth: authDep, getRaces: async () => BIG_RESULT });
}

function rawGet(port, path, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers: { "Accept-Encoding": acceptEncoding } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function withServer(run) {
  const server = http.createServer(makeApp());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await run(server.address().port);
  } finally {
    server.close();
  }
}

test("gzip and uncompressed /races decode to identical JSON; Vary is set", async () => {
  await withServer(async (port) => {
    const gz = await rawGet(port, "/races", "gzip");
    const plain = await rawGet(port, "/races", "identity");

    // The gzip request is actually gzip-encoded and advertises Vary.
    assert.equal(gz.headers["content-encoding"], "gzip");
    assert.match(gz.headers["vary"] || "", /Accept-Encoding/i);

    // The identity request is NOT gzip-encoded.
    assert.notEqual(plain.headers["content-encoding"], "gzip");

    // Both decode to the exact same JSON contract.
    const gzJson = JSON.parse(zlib.gunzipSync(gz.body).toString("utf8"));
    const plainJson = JSON.parse(plain.body.toString("utf8"));
    assert.deepEqual(gzJson, plainJson);
    assert.deepEqual(gzJson, BIG_RESULT);
  });
});

test("no Brotli is emitted even if the client offers it (gzip-only contract)", async () => {
  await withServer(async (port) => {
    const res = await rawGet(port, "/races", "br, gzip");
    // Never 'br' — the client contract is gzip-only.
    assert.notEqual(res.headers["content-encoding"], "br");
    assert.equal(res.headers["content-encoding"], "gzip");
  });
});

test("compact launch payloads skip gzip work even when they exceed one KiB", async () => {
  await withServer(async (port) => {
    const res = await rawGet(port, "/races?view=compact-v1", "gzip");
    assert.equal(res.headers["content-encoding"], undefined);
    assert.deepEqual(JSON.parse(res.body.toString("utf8")), BIG_RESULT);
  });
});
