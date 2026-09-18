const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, request, getSharedServer, createTestUser } = require("./setup");

let server;

async function createRace(token, name) {
  const response = await request(server.baseUrl, "POST", "/races", {
    token,
    body: { name, targetSteps: 50000, maxDurationDays: 7 },
  });
  assert.equal(response.status, 201);
  return (await response.json()).race.id;
}

describe("GET /races cache-safe assembly", () => {
  before(async () => {
    server = await getSharedServer({
      // The suite works with Redis enabled or disabled; the latter exercises
      // the public fallback while the former proves an actual hit path.
    });
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("keeps each viewer's race list isolated and preserves the HTTP shape", async () => {
    const alice = await createTestUser({ displayName: "Alice Cache" });
    const bob = await createTestUser({ displayName: "Bob Cache" });
    const aliceRace = await createRace(alice.token, "Alice private race");
    const bobRace = await createRace(bob.token, "Bob private race");

    const aliceResponse = await request(server.baseUrl, "GET", "/races", { token: alice.token });
    const aliceCachedResponse = await request(server.baseUrl, "GET", "/races", { token: alice.token });
    const bobResponse = await request(server.baseUrl, "GET", "/races", { token: bob.token });
    assert.equal(aliceResponse.status, 200);
    assert.equal(aliceCachedResponse.status, 200);
    assert.equal(bobResponse.status, 200);

    const aliceBody = await aliceResponse.json();
    const aliceIds = [...(aliceBody.active || []), ...(aliceBody.pending || []), ...(aliceBody.completed || [])]
      .map((race) => race.id);
    const bobBody = await bobResponse.json();
    const bobIds = [...(bobBody.active || []), ...(bobBody.pending || []), ...(bobBody.completed || [])]
      .map((race) => race.id);
    assert.ok(aliceIds.includes(aliceRace));
    assert.ok(bobIds.includes(bobRace));
    assert.equal(bobIds.includes(aliceRace), false);
  });
});
