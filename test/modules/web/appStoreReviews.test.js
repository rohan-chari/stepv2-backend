const assert = require("node:assert/strict");
const { describe, it, beforeEach } = require("node:test");

const {
  getFiveStarReviews,
  parseFeed,
  resetCacheForTests,
  CACHE_TTL_MS,
} = require("../../../src/modules/web/reviews/appStoreReviews");

// These are unit tests on purpose, and this is the narrow case CLAUDE.md carves
// out: the properties that matter here are what happens when APPLE misbehaves —
// a feed with a low-star review in it, an upstream outage, a second call inside
// the cache window. None of those can be provoked through the public HTTP path,
// because we cannot make a third party fail on demand.
//
// The happy path IS covered end-to-end: test/integration/marketing-site.test.js
// hits GET /reviews/ios on a real server and asserts nothing but 5-star reviews
// come back.

function entry({ rating, id = "1", title = "Great", body = "Really fun app", author = "Someone" }) {
  const built = {
    id: { label: id },
    title: { label: title },
    content: { label: body },
    author: { name: { label: author } },
  };
  if (rating !== undefined) built["im:rating"] = { label: String(rating) };
  return built;
}

function feed(entries) {
  return { feed: { entry: entries } };
}

describe("parseFeed", () => {
  it("keeps 5-star reviews and drops everything below", () => {
    const reviews = parseFeed(
      feed([
        entry({ rating: 5, id: "a", title: "Love it" }),
        entry({ rating: 4, id: "b" }),
        entry({ rating: 3, id: "c" }),
        entry({ rating: 1, id: "d" }),
        entry({ rating: 5, id: "e", title: "Great" }),
      ])
    );

    assert.deepEqual(
      reviews.map((r) => r.id),
      ["a", "e"]
    );
  });

  // The first element of Apple's feed is the APP record, not a review. It has
  // no im:rating, which is what we key off — a positional slice would drop a
  // real review whenever Apple changes the envelope.
  it("skips the app record that has no rating", () => {
    const appRecord = { id: { label: "app" }, title: { label: "Bara" } };
    const reviews = parseFeed(feed([appRecord, entry({ rating: 5, id: "r1" })]));

    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].id, "r1");
  });

  it("returns an empty list for an empty or malformed feed", () => {
    assert.deepEqual(parseFeed(undefined), []);
    assert.deepEqual(parseFeed({}), []);
    assert.deepEqual(parseFeed({ feed: {} }), []);
    assert.deepEqual(parseFeed({ feed: { entry: "not an array" } }), []);
    assert.deepEqual(parseFeed(feed([])), []);
  });

  it("truncates a long body at a word boundary rather than mid-word", () => {
    const long = `${"walking ".repeat(60)}end`;
    const [review] = parseFeed(feed([entry({ rating: 5, body: long })]));

    assert.ok(review.body.length <= 241, `body was ${review.body.length} chars`);
    assert.ok(review.body.endsWith("…"));
    assert.ok(!review.body.includes("  "));
  });

  it("collapses newlines so a multi-line review cannot break the strip layout", () => {
    const [review] = parseFeed(
      feed([entry({ rating: 5, body: "line one\n\nline two" })])
    );
    assert.equal(review.body, "line one line two");
  });
});

describe("getFiveStarReviews", () => {
  beforeEach(() => {
    resetCacheForTests();
  });

  it("caches, so a second call inside the window does not re-fetch", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return parseFeed(feed([entry({ rating: 5, id: "r1" })]));
    };

    await getFiveStarReviews({ fetchImpl });
    const second = await getFiveStarReviews({ fetchImpl });

    assert.equal(calls, 1);
    assert.equal(second.reviews[0].id, "r1");
  });

  it("re-fetches once the cache window has passed", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return parseFeed(feed([entry({ rating: 5, id: `r${calls}` })]));
    };

    let clock = 1_000_000;
    await getFiveStarReviews({ fetchImpl, now: () => clock });
    clock += CACHE_TTL_MS + 1;
    const second = await getFiveStarReviews({ fetchImpl, now: () => clock });

    assert.equal(calls, 2);
    assert.equal(second.reviews[0].id, "r2");
  });

  // The whole point of the module: barastep.com must not break because Apple is
  // down. A stale review is a better answer than an error page.
  it("serves the last good payload when the feed fails, however stale", async () => {
    let shouldFail = false;
    const fetchImpl = async () => {
      if (shouldFail) throw new Error("upstream exploded");
      return parseFeed(feed([entry({ rating: 5, id: "warm" })]));
    };

    let clock = 1_000_000;
    await getFiveStarReviews({ fetchImpl, now: () => clock });

    shouldFail = true;
    clock += CACHE_TTL_MS * 100;
    const stale = await getFiveStarReviews({ fetchImpl, now: () => clock });

    assert.equal(stale.reviews.length, 1);
    assert.equal(stale.reviews[0].id, "warm");
  });

  it("returns an empty list, not a rejection, when the feed fails cold", async () => {
    const fetchImpl = async () => {
      throw new Error("upstream exploded");
    };

    const result = await getFiveStarReviews({ fetchImpl });
    assert.deepEqual(result, { reviews: [] });
  });

  // Without a negative cache, a cold start (the state after every pm2 reload)
  // during an Apple outage means EVERY visitor triggers its own 5s outbound
  // fetch — a third party's downtime becoming sustained load on a one-vCPU box.
  it("backs off after a failure instead of re-fetching on every request", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      throw new Error("upstream exploded");
    };

    let clock = 1_000_000;
    const now = () => clock;

    await getFiveStarReviews({ fetchImpl, now });
    await getFiveStarReviews({ fetchImpl, now });
    await getFiveStarReviews({ fetchImpl, now });

    assert.equal(calls, 1, "a failing upstream must not be re-hit per request");

    // ...but the backoff is a pause, not a give-up.
    clock += 10 * 60 * 1000;
    await getFiveStarReviews({ fetchImpl, now });
    assert.equal(calls, 2, "it must retry once the backoff window has passed");
  });

  // N visitors arriving together on a cold cache all want the same answer.
  it("collapses concurrent cold-start requests into one upstream call", async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const fetchImpl = async () => {
      calls++;
      await gate;
      return parseFeed(feed([entry({ rating: 5, id: "r1" })]));
    };

    const inFlight = [
      getFiveStarReviews({ fetchImpl }),
      getFiveStarReviews({ fetchImpl }),
      getFiveStarReviews({ fetchImpl }),
    ];
    release();
    const results = await Promise.all(inFlight);

    assert.equal(calls, 1, "concurrent callers must share one upstream call");
    for (const result of results) {
      assert.equal(result.reviews[0].id, "r1");
    }
  });
});
