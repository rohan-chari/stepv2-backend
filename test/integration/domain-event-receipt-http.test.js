const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { before, beforeEach, describe, it } = require("node:test");

// Fail before loading application/database modules. The runner must supply a
// dedicated disposable DB explicitly; do not fall back to the developer .env.
assert.ok(process.env.DATABASE_URL, "Supply a dedicated DATABASE_URL ending in _test");
assert.match(
  decodeURIComponent(new URL(process.env.DATABASE_URL).pathname),
  /_test$/,
  "Receipt HTTP tests must only use a dedicated _test database",
);

const {
  cleanDatabase,
  createTestUser,
  getSharedServer,
  prisma,
  request,
} = require("./setup");

const OLD_CLIENT_HEADERS = { "X-Client-Features": "inbox_v1" };
let server;

function assertFriendshipResponse(body, { requesterId, addresseeId, status, id }) {
  const friendship = body.friendship;
  assert.ok(friendship);
  assert.equal(typeof friendship.id, "string");
  assert.ok(friendship.id.length > 0);
  if (id) assert.equal(friendship.id, id);
  assert.ok(Number.isFinite(Date.parse(friendship.createdAt)));
  assert.ok(Number.isFinite(Date.parse(friendship.updatedAt)));
  assert.deepEqual(body, {
    friendship: {
      id: friendship.id,
      requesterId,
      addresseeId,
      status,
      relationshipType: null,
      createdAt: friendship.createdAt,
      updatedAt: friendship.updatedAt,
    },
  });
  return friendship;
}

async function assertFinalReceipt({ friendship, eventType, payload, recipientId, occurredAt }) {
  const eventKey = `${eventType}:${friendship.id}`;
  const [events, receipts] = await Promise.all([
    prisma.domainEventOutbox.findMany({
      where: { eventKey },
      include: { audience: { orderBy: { ordinal: "asc" } } },
      take: 2,
    }),
    prisma.domainEventReceipt.findMany({ where: { eventKey }, take: 2 }),
  ]);
  assert.equal(events.length, 1, "HTTP success must commit exactly one outbox event");
  assert.equal(receipts.length, 1, "HTTP success must already have its receipt without a worker");
  const [event] = events;
  const [receipt] = receipts;
  assert.equal(event.eventType, eventType);
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.aggregateType, "FRIENDSHIP");
  assert.equal(event.aggregateId, friendship.id);
  assert.equal(event.occurredAt.toISOString(), occurredAt);
  assert.equal(event.availableAt.toISOString(), occurredAt);
  assert.deepEqual(event.payload, payload);
  assert.deepEqual(
    event.audience.map(({ ordinal, recipientId, facts }) => ({ ordinal, recipientId, facts })),
    [{ ordinal: 0, recipientId, facts: {} }],
  );

  // Independently construct this fixture's V1 envelope. No production command,
  // receipt helper, projection worker, or repair job is invoked by this suite.
  const canonicalPayload = Object.fromEntries(
    Object.keys(payload).sort().map((key) => [key, payload[key]]),
  );
  const digest = createHash("sha256").update(JSON.stringify({
    eventKey,
    eventType,
    schemaVersion: 1,
    aggregateType: "FRIENDSHIP",
    aggregateId: friendship.id,
    occurredAt,
    availableAt: occurredAt,
    payload: canonicalPayload,
    audience: [{ ordinal: 0, recipientId, facts: {} }],
  }), "utf8").digest("hex");

  assert.equal(receipt.receiptState, "FINAL", "the overlap trigger's PROVISIONAL row is insufficient");
  assert.equal(receipt.digestVersion, 1);
  assert.equal(receipt.envelopeDigest, digest);
  assert.ok(receipt.finalizedAt instanceof Date);
  assert.equal(receipt.domainEventId, event.id);
  assert.equal(receipt.eventType, eventType);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.aggregateType, "FRIENDSHIP");
  assert.equal(receipt.aggregateId, friendship.id);
  assert.equal(receipt.occurredAt.toISOString(), occurredAt);
  assert.equal(receipt.availableAt.toISOString(), occurredAt);
  assert.equal(receipt.replaySourceType, "FRIENDSHIP");
  assert.equal(receipt.replaySourceId, friendship.id);
  return { event, receipt };
}

describe("domain event receipts through unchanged friendship HTTP endpoints", () => {
  before(async () => { server = await getSharedServer(); });
  beforeEach(async () => { await cleanDatabase(); });

  for (const [client, headers] of [
    ["no capability header", {}],
    ["the old inbox_v1 capability header", OLD_CLIENT_HEADERS],
  ]) {
    it(`commits a FINAL receipt and preserves duplicate-send behavior with ${client}`, async () => {
      const requester = await createTestUser();
      const addressee = await createTestUser();
      const options = { token: requester.token, headers, body: { addresseeId: addressee.user.id } };
      const response = await request(server.baseUrl, "POST", "/friends/request", options);
      assert.equal(response.status, 201);
      const friendship = assertFriendshipResponse(await response.json(), {
        requesterId: requester.user.id, addresseeId: addressee.user.id, status: "PENDING",
      });
      const expected = {
        friendship,
        eventType: "FRIEND_REQUEST_SENT_V1",
        payload: { friendshipId: friendship.id, requesterId: requester.user.id, addresseeId: addressee.user.id },
        recipientId: addressee.user.id,
        occurredAt: friendship.createdAt,
      };
      const committed = await assertFinalReceipt(expected);

      // The public endpoint rejects a retry before append; preserve that old
      // contract instead of manufacturing an internal receipt replay here.
      const retry = await request(server.baseUrl, "POST", "/friends/request", options);
      assert.equal(retry.status, 409);
      assert.deepEqual(await retry.json(), { error: "A friend request already exists" });
      assert.deepEqual(await assertFinalReceipt(expected), committed);
      assert.equal(await prisma.domainEventOutbox.count({
        where: { aggregateType: "FRIENDSHIP", aggregateId: friendship.id },
      }), 1);
      assert.equal(await prisma.domainEventReceipt.count({
        where: { replaySourceType: "FRIENDSHIP", replaySourceId: friendship.id },
      }), 1);

      const incoming = await request(server.baseUrl, "GET", "/friends", {
        token: addressee.token, headers,
      });
      assert.equal(incoming.status, 200);
      const body = await incoming.json();
      assert.equal(body.pending.incoming.length, 1);
      assert.equal(body.pending.incoming[0].friendshipId, friendship.id);
      assert.equal(body.pending.incoming[0].user.id, requester.user.id);
    });
  }

  it("accepts the legacy body, commits its FINAL receipt, and keeps it immutable on HTTP retry", async () => {
    const requester = await createTestUser();
    const addressee = await createTestUser();
    const sent = await request(server.baseUrl, "POST", "/friends/request", {
      token: requester.token, headers: OLD_CLIENT_HEADERS,
      body: { addresseeId: addressee.user.id },
    });
    assert.equal(sent.status, 201);
    const pending = assertFriendshipResponse(await sent.json(), {
      requesterId: requester.user.id, addresseeId: addressee.user.id, status: "PENDING",
    });
    const options = { token: addressee.token, headers: OLD_CLIENT_HEADERS, body: { accept: true } };
    const path = `/friends/request/${pending.id}`;
    const accepted = await request(server.baseUrl, "PUT", path, options);
    assert.equal(accepted.status, 200);
    const friendship = assertFriendshipResponse(await accepted.json(), {
      requesterId: requester.user.id, addresseeId: addressee.user.id, status: "ACCEPTED", id: pending.id,
    });
    const expected = {
      friendship,
      eventType: "FRIEND_REQUEST_ACCEPTED_V1",
      payload: { friendshipId: friendship.id, accepterId: addressee.user.id, requesterId: requester.user.id },
      recipientId: requester.user.id,
      occurredAt: friendship.updatedAt,
    };
    const committed = await assertFinalReceipt(expected);
    const retry = await request(server.baseUrl, "PUT", path, options);
    assert.equal(retry.status, 409);
    assert.deepEqual(await retry.json(), { error: "This request has already been responded to" });
    assert.deepEqual(await assertFinalReceipt(expected), committed);
    assert.equal(await prisma.domainEventOutbox.count({
      where: { aggregateType: "FRIENDSHIP", aggregateId: friendship.id },
    }), 2);
    assert.equal(await prisma.domainEventReceipt.count({
      where: { replaySourceType: "FRIENDSHIP", replaySourceId: friendship.id },
    }), 2);

    const friends = await request(server.baseUrl, "GET", "/friends", {
      token: requester.token, headers: OLD_CLIENT_HEADERS,
    });
    assert.equal(friends.status, 200);
    const body = await friends.json();
    assert.equal(body.friends.length, 1);
    assert.equal(body.friends[0].id, addressee.user.id);
    assert.equal(body.pending.outgoing.length, 0);
  });
});
