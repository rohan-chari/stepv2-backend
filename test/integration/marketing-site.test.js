const assert = require("node:assert/strict");
const { describe, it, before, after, beforeEach } = require("node:test");
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
      ["/privacy", "not write to or modify your health data"],
      ["/support", "Common trail troubles"],
      ["/", "more fun when you can steal"],
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

  // The header lockup and the review strip are the two pieces a visitor sees
  // before anything else, and both would fail silently: a missing logo is a
  // broken-image icon, and an empty strip just looks like a design choice.
  it("ships the wordmark lockup and its logo in the served HTML", async () => {
    const html = await (await fetch(`${server.baseUrl}/`)).text();

    // The visible text is split across spans for the responsive truncation, so
    // assert on the accessible name — the one string that is always complete.
    assert.ok(
      html.includes('aria-label="Bara: Step Challenges"'),
      "the wordmark must carry the full name as its accessible name"
    );
    assert.ok(
      html.includes("/icon-192.png"),
      "the wordmark must reference the app icon"
    );
    assert.ok(
      html.includes("Jersey+25"),
      "the page must request the app's own wordmark face"
    );
  });

  it("ships real review copy in the HTML, so the strip is not JS-only", async () => {
    const html = await (await fetch(`${server.baseUrl}/`)).text();
    const snapshot = require("../../web/src/data/reviews.json");

    assert.ok(snapshot.length > 0, "the build-time review snapshot should not be empty");
    assert.ok(
      html.includes(snapshot[0].body),
      "the prerendered HTML must already contain review copy"
    );
  });

  // Smoke test against the REAL feed. Deliberately weak — it must pass whatever
  // Apple says today, including saying nothing — so the filter itself is proved
  // by the stubbed-feed test below, which cannot silently pass on an empty list.
  it("answers /reviews/ios with a 200 and a well-formed list", async () => {
    const res = await fetch(`${server.baseUrl}/reviews/ios`);
    assert.equal(res.status, 200);

    const body = await res.json();
    assert.ok(Array.isArray(body.reviews), "reviews must be an array");
    for (const review of body.reviews) {
      assert.equal(review.rating, 5, `leaked a ${review.rating}-star review`);
      assert.equal(typeof review.body, "string");
    }
  });
  // The powerups are what the "what's in the boxes" section exists to sell, and
  // they now live inside the mystery-box reel (web/src/components/PowerupReel.vue)
  // rather than a plain grid. The reel is a scroll-snap track precisely so it
  // still works with no JavaScript — but only if the tiles and their copy are in
  // the PRERENDERED html. Were it ever to regress to a client-only render, the
  // section would degrade to an empty felt window and nothing else would fail.
  //
  // Asserted on the served HTML, escaped exactly as Vue's SSR pass writes it.
  it("ships every powerup's name and effect in the reel's prerendered HTML", async () => {
    const html = await (await fetch(`${server.baseUrl}/`)).text();

    const powerups = [
      ["Protein Shake", "+1,500 bonus steps, instantly."],
      ["Runner&#39;s High", "2x your steps for an hour."],
      ["Wrong Turn", "Reverse a rival&#39;s steps for an hour."],
      ["Stealth Mode", "Hide your name, steps, and position for an hour."],
      ["Trail Mine", "Buries a trap at your step count."],
      ["Rainstorm", "Everyone else&#39;s steps count for half for an hour."],
    ];

    for (const [name, effect] of powerups) {
      assert.ok(html.includes(name), `the reel must name ${name}`);
      assert.ok(
        html.includes(effect),
        `${name}'s effect copy must be in the served HTML, not JS-only`
      );
    }

    // The chrome itself, so a reel that renders its contents into no cabinet
    // (a dropped stylesheet class, a refactor that loses the track) is caught.
    assert.ok(html.includes("reel-track"), "the reel's scroll track must be present");
    assert.ok(
      html.includes("reel-tile"),
      "the reel must render tiles, not just the caption"
    );
  });

  it("keeps serving the untouched static files out of public/", async () => {
    const adsRes = await fetch(`${server.baseUrl}/app-ads.txt`);
    assert.equal(adsRes.status, 200);
    assert.match(adsRes.headers.get("content-type") || "", /text\/plain/);

    const cardRes = await fetch(`${server.baseUrl}/share-card.png`);
    assert.equal(cardRes.status, 200);
  });

  // The Bara app icon in the browser tab. These paths are hardcoded in both the
  // built HTML and the server-rendered landing-page shells, and /favicon.ico is
  // requested by browsers with no link tag at all — so all of them must resolve.
  it("serves the app icon at every path the pages and browsers ask for", async () => {
    for (const path of [
      "/favicon.ico",
      "/favicon-32.png",
      "/apple-touch-icon.png",
      "/apple-touch-icon-precomposed.png",
      "/icon-192.png",
    ]) {
      const res = await fetch(`${server.baseUrl}${path}`);
      assert.equal(res.status, 200, `${path} should be 200`);
      assert.match(
        res.headers.get("content-type") || "",
        /image\/png/,
        `${path} should be served as a PNG`
      );
    }
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

describe("GET /reviews/ios filters the feed it is given", () => {
  const {
    getFiveStarReviews,
    parseFeed,
    resetCacheForTests,
  } = require("../../src/modules/web/reviews/appStoreReviews");
  const { startServer } = require("./setup");

  function entry(rating, id, body) {
    return {
      id: { label: id },
      title: { label: `Title ${id}` },
      content: { label: body },
      author: { name: { label: `Author ${id}` } },
      "im:rating": { label: String(rating) },
    };
  }

  // The first element of Apple's real feed is the app record, which carries no
  // im:rating — included here so the route is exercised against the shape it
  // actually receives.
  const STUB_FEED = {
    feed: {
      entry: [
        { id: { label: "app" }, title: { label: "Bara" } },
        entry(5, "keep-1", "Genuinely five stars"),
        entry(1, "drop-1", "One star, must never ship"),
        entry(3, "drop-2", "Three stars, must never ship"),
        entry(5, "keep-2", "Also five stars"),
        entry(4, "drop-3", "Four stars, still must never ship"),
      ],
    },
  };

  let stubbed;

  before(async () => {
    resetCacheForTests();
    stubbed = await startServer({
      getFiveStarReviews: () =>
        getFiveStarReviews({ fetchImpl: async () => parseFeed(STUB_FEED) }),
    });
  });

  after(async () => {
    await stubbed.close();
    resetCacheForTests();
  });

  it("returns the 5-star entries and drops every lower rating", async () => {
    const res = await fetch(`${stubbed.baseUrl}/reviews/ios`);
    assert.equal(res.status, 200);

    const { reviews } = await res.json();
    assert.deepEqual(
      reviews.map((r) => r.id),
      ["keep-1", "keep-2"],
      "only the 5-star entries may reach the page"
    );

    const serialized = JSON.stringify(reviews);
    for (const leaked of ["drop-1", "drop-2", "drop-3", "must never ship"]) {
      assert.ok(
        !serialized.includes(leaked),
        `low-star content "${leaked}" reached the response`
      );
    }
  });

});
