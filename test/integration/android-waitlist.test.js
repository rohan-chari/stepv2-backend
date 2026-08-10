const assert = require("node:assert/strict");
const { describe, it, before, beforeEach } = require("node:test");
const { cleanDatabase, prisma, request, getSharedServer } = require("./setup");

// POST /waitlist/android — the marketing site's Android email capture.
//
// Public and unauthenticated by design (the caller is a browser on
// barastep.com, never the app). The behaviours that matter:
//   * a valid new email lands in the table,
//   * resubmitting is a SUCCESS, not an error — a user who refreshes and
//     submits again must see the same confirmation,
//   * that idempotency survives case/whitespace differences, which is the whole
//     reason the command normalizes before hitting the unique index,
//   * garbage input is a 400 with the documented code and writes nothing.
//
// The last block guards the static-serving change that shipped alongside this
// endpoint: /, /privacy and /support now sendFile out of web/dist instead of
// public/, and a wrong path there is a broken production site.

let server;

describe("POST /waitlist/android", () => {
  before(async () => {
    server = await getSharedServer();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  it("adds a valid new email to the waitlist", async () => {
    const res = await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: "walker@example.com" },
    });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const rows = await prisma.androidWaitlistEntry.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "walker@example.com");
  });

  it("treats a resubmission of the same email as success, not an error", async () => {
    const first = await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: "walker@example.com" },
    });
    assert.equal(first.status, 200);

    const second = await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: "walker@example.com" },
    });

    // Same status AND same body as the first call: the response must not reveal
    // whether the address was already on the list.
    assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { ok: true });

    const rows = await prisma.androidWaitlistEntry.findMany();
    assert.equal(rows.length, 1);
  });

  it("normalizes case and whitespace so a differently-cased resubmission is the same entry", async () => {
    await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: "walker@example.com" },
    });

    const res = await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: "  Walker@Example.COM  " },
    });
    assert.equal(res.status, 200);

    // Without trim+lowercase before the insert, the unique index never fires and
    // this is a second row.
    const rows = await prisma.androidWaitlistEntry.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "walker@example.com");
  });

  it("stores the normalized form even when the first submission is messy", async () => {
    const res = await request(server.baseUrl, "POST", "/waitlist/android", {
      body: { email: " TRAILBLAZER@Example.com " },
    });
    assert.equal(res.status, 200);

    const rows = await prisma.androidWaitlistEntry.findMany();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, "trailblazer@example.com");
  });

  it("rejects malformed, missing, and oversized emails without writing a row", async () => {
    const badBodies = [
      { email: "not-an-email" },
      { email: "no-at-sign.com" },
      { email: "spaces in@example.com" },
      { email: "missing-tld@example" },
      { email: "" },
      { email: "   " },
      { email: null },
      { email: 42 },
      {},
      // 254 is the RFC cap; this exceeds it.
      { email: `${"a".repeat(250)}@example.com` },
    ];

    for (const body of badBodies) {
      const res = await request(server.baseUrl, "POST", "/waitlist/android", {
        body,
      });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      const json = await res.json();
      assert.equal(json.code, "WAITLIST_INVALID_EMAIL");
    }

    const rows = await prisma.androidWaitlistEntry.findMany();
    assert.equal(rows.length, 0);
  });
});

// Regression guard for the public/ -> web/dist static-serving switch. These
// URLs are public-facing (the App Store listing links /privacy) and are served
// by explicit sendFile paths, so a wrong directory is a silently broken site.
describe("marketing site + static routes still serve", () => {
  before(async () => {
    server = await getSharedServer();
  });

  it("serves the built marketing pages from web/dist", async () => {
    for (const path of ["/", "/privacy", "/privacy.html", "/support", "/support.html"]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.status, 200, `${path} should be 200`);
      const html = await res.text();
      assert.match(html, /<!doctype html>/i, `${path} should return an HTML document`);
    }
  });

  // A 200 with an HTML document is NOT enough: if Vite's asset directory ever
  // collides with the /assets CDN mount (fallthrough:false => hard 404), every
  // page still returns 200 while shipping no CSS and no JS. Fetch each bundle
  // the built HTML actually references.
  it("serves every bundle the built pages reference", async () => {
    let checked = 0;
    for (const page of ["/", "/privacy", "/support"]) {
      const html = await (await fetch(`${server.baseUrl}${page}`)).text();
      const urls = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css|png))"/g)].map(
        (m) => m[1]
      );
      assert.ok(urls.length > 0, `${page} should reference at least one bundled asset`);
      for (const url of urls) {
        const res = await fetch(`${server.baseUrl}${url}`);
        assert.equal(res.status, 200, `${url} (referenced by ${page}) should be 200`);
        checked++;
      }
    }
    assert.ok(checked >= 6, `expected several assets, checked ${checked}`);
  });

  // The pages must carry their copy in the HTML itself. /privacy is the URL on
  // the App Store listing and /support is where people go when something is
  // already broken; neither may render blank when the JS fails to load.
  it("ships page copy in the HTML, not just a JS mount point", async () => {
    const expectations = [
      ["/privacy", "we do not write to or modify your health data"],
      ["/support", "Common trail troubles"],
      ["/", "Your steps are"],
    ];
    for (const [path, prose] of expectations) {
      const html = await (await fetch(`${server.baseUrl}${path}`)).text();
      assert.ok(
        html.includes(prose),
        `${path} must contain its prerendered copy ("${prose}") in the served HTML`
      );
      assert.ok(
        !html.includes('<div id="app"></div>'),
        `${path} must not ship an empty mount point`
      );
    }
  });

  it("keeps serving the untouched static files out of public/", async () => {
    const adsRes = await fetch(`${server.baseUrl}/app-ads.txt`);
    assert.equal(adsRes.status, 200);
    assert.match(adsRes.headers.get("content-type") || "", /text\/plain/);

    const cardRes = await fetch(`${server.baseUrl}/share-card.png`);
    assert.equal(cardRes.status, 200);
  });

  it("serves the deep-link verification files unchanged", async () => {
    const aasa = await fetch(
      `${server.baseUrl}/.well-known/apple-app-site-association`
    );
    assert.equal(aasa.status, 200);

    const assetLinks = await fetch(`${server.baseUrl}/.well-known/assetlinks.json`);
    assert.equal(assetLinks.status, 200);
  });
});
