const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

let server;
let nextAppleId = 0;

async function createUser(displayName) {
  const appleId = `apple-share-${++nextAppleId}`;
  const res = await request(server.baseUrl, "POST", "/auth/apple", {
    body: { identityToken: appleId },
  });
  const body = await res.json();
  if (displayName) {
    await request(server.baseUrl, "PUT", "/auth/me/display-name", {
      body: { displayName },
      token: body.sessionToken,
    });
  }
  return { userId: body.user.id, token: body.sessionToken };
}

async function createRace(token, overrides = {}) {
  const res = await request(server.baseUrl, "POST", "/races", {
    body: {
      name: overrides.name || "Private Crew Race",
      targetSteps: overrides.targetSteps || 50000,
      maxDurationDays: overrides.maxDurationDays || 7,
      // isPublic omitted => defaults FALSE. The whole point of share links is
      // that they work for private races.
      ...overrides,
    },
    token,
  });
  return res;
}

describe("race share links", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
    nextAppleId = 0;
  });

  it("a participant can mint a share link (idempotent)", async () => {
    const alice = await createUser("AliceWalker");
    const raceId = (await (await createRace(alice.token)).json()).race.id;

    const first = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: alice.token }
    );
    assert.equal(first.status, 201);
    const firstBody = await first.json();
    assert.match(firstBody.shareToken, /^[0-9a-f]{32}$/);
    assert.match(firstBody.url, /\/r\/[0-9a-f]{32}\?ref=BARA-[A-Z0-9]{4}$/);

    // Idempotent: the same race returns the same token.
    const second = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: alice.token }
    );
    assert.equal((await second.json()).shareToken, firstBody.shareToken);
  });

  it("a non-participant cannot mint a share link (403)", async () => {
    const alice = await createUser("AliceWalker");
    const stranger = await createUser("StrangerDanger");
    const raceId = (await (await createRace(alice.token)).json()).race.id;

    const res = await request(
      server.baseUrl,
      "POST",
      `/races/${raceId}/share-link`,
      { token: stranger.token }
    );
    assert.equal(res.status, 403);
  });

  it("the preview is readable WITHOUT auth and hides internal fields", async () => {
    const alice = await createUser("AliceWalker");
    const raceId = (
      await (await createRace(alice.token, { name: "Sunrise Sprint" })).json()
    ).race.id;
    const { shareToken } = await (
      await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
        token: alice.token,
      })
    ).json();

    // No token passed => unauthenticated request.
    const res = await request(
      server.baseUrl,
      "GET",
      `/races/share/${shareToken}`
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.race.name, "Sunrise Sprint");
    assert.equal(body.race.participantCount, 1);
    assert.equal(body.race.host.displayName, "AliceWalker");
    assert.equal(body.race.creatorId, undefined);
    assert.equal(body.race.shareToken, undefined);
    assert.equal(body.race.participants, undefined);
  });

  it("preview 404s for an unknown token", async () => {
    const res = await request(
      server.baseUrl,
      "GET",
      `/races/share/deadbeefdeadbeefdeadbeefdeadbeef`
    );
    assert.equal(res.status, 404);
  });

  it("a stranger can JOIN a PRIVATE race via the share token (bypasses isPublic)", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobbyRunner");
    const raceId = (await (await createRace(alice.token)).json()).race.id;
    const { shareToken } = await (
      await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
        token: alice.token,
      })
    ).json();

    const join = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: bob.token }
    );
    assert.equal(join.status, 201);
    const joinBody = await join.json();
    assert.equal(joinBody.raceId, raceId);
    assert.equal(joinBody.participant.status, "ACCEPTED");

    // Bob now appears as an ACCEPTED participant in the race details.
    const detail = await (
      await request(server.baseUrl, "GET", `/races/${raceId}`, {
        token: alice.token,
      })
    ).json();
    const bobP = detail.participants.find((p) => p.userId === bob.userId);
    assert.ok(bobP);
    assert.equal(bobP.status, "ACCEPTED");
  });

  it("joining twice via the token is rejected (400 already in race)", async () => {
    const alice = await createUser("AliceWalker");
    const bob = await createUser("BobbyRunner");
    const raceId = (await (await createRace(alice.token)).json()).race.id;
    const { shareToken } = await (
      await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
        token: alice.token,
      })
    ).json();

    await request(server.baseUrl, "POST", `/races/share/${shareToken}/join`, {
      token: bob.token,
    });
    const again = await request(
      server.baseUrl,
      "POST",
      `/races/share/${shareToken}/join`,
      { token: bob.token }
    );
    assert.equal(again.status, 400);
  });

  it("join 404s for an unknown token", async () => {
    const bob = await createUser("BobbyRunner");
    const res = await request(
      server.baseUrl,
      "POST",
      `/races/share/deadbeefdeadbeefdeadbeefdeadbeef/join`,
      { token: bob.token }
    );
    assert.equal(res.status, 404);
  });

  it("serves apple-app-site-association as JSON claiming /r/*", async () => {
    const res = await request(
      server.baseUrl,
      "GET",
      "/.well-known/apple-app-site-association"
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    const detail = body.applinks.details[0];
    assert.ok(detail.components.some((c) => c["/"] === "/r/*"));
  });

  it("serves assetlinks.json as a delegate_permission array", async () => {
    const res = await request(
      server.baseUrl,
      "GET",
      "/.well-known/assetlinks.json"
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body[0].relation[0], "delegate_permission/common.handle_all_urls");
  });

  it("renders the web landing page (200) with the race name", async () => {
    const alice = await createUser("AliceWalker");
    const raceId = (
      await (await createRace(alice.token, { name: "Landing Page Race" })).json()
    ).race.id;
    const { shareToken } = await (
      await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
        token: alice.token,
      })
    ).json();

    const res = await request(server.baseUrl, "GET", `/r/${shareToken}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Landing Page Race/);
    assert.match(html, /og:title/);
  });

  it("preserves race + referral through the combined landing and records both opens", async () => {
    const alice = await createUser("AliceWalker");
    const raceId = (await (await createRace(alice.token)).json()).race.id;
    const share = await request(server.baseUrl, "POST", `/races/${raceId}/share-link`, {
      token: alice.token,
    });
    const { url } = await share.json();
    const parsed = new URL(url);
    const res = await fetch(`${server.baseUrl}${parsed.pathname}${parsed.search}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /bara:\/\/join\/[0-9a-f]{32}\?ref=BARA-[A-Z0-9]{4}/);
    assert.match(html, /id="playstore"[^>]+aria-disabled="true"/);
    assert.match(html, /navigator\.clipboard\.writeText\(/);
    assert.match(html, new RegExp(JSON.stringify(url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(html, /window\.location\.href=app\.href/);

    for (let i = 0; i < 20; i++) {
      const count = await prisma.linkOpen.count({ where: { sourceRaceId: raceId } });
      if (count >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const opens = await prisma.linkOpen.findMany({
      where: { sourceRaceId: raceId },
      orderBy: { kind: "asc" },
    });
    assert.deepEqual(opens.map((open) => open.kind).sort(), ["race_share", "referral"]);
  });

  it("renders a 404 landing page for an unknown token", async () => {
    const res = await request(server.baseUrl, "GET", `/r/unknown-token`);
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.match(html, /not found|no longer/i);
  });
});
