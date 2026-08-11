// Fetches, filters and caches the app's public App Store customer reviews for
// the marketing site's scrolling review strip.
//
// ── Why a first-party proxy and not Elfsight/SociableKIT ─────────────────────
// A hosted review widget means a remote <script> on every page: a new script
// origin, a render-blocking third party, that vendor receiving the IP and user
// agent of every visitor, and a subscription — all to re-serve a feed Apple
// publishes for free and anonymously. This module is ~80 lines and keeps the
// site's "no third-party origins" property intact.
//
// ── Guarantees this module owes the page ─────────────────────────────────────
//  * ONLY 5-star reviews leave here. The filter is server-side so a bug in the
//    client can never surface a 1-star review on the marketing page.
//  * It NEVER throws and never propagates an upstream failure. barastep.com
//    must not 500 because Apple is having a bad day; a stale or empty list is
//    always the better answer.
//
// Review text is user-generated content from a third party. Everything here
// returns plain strings — escaping is the renderer's job (Vue interpolation on
// the client, renderToString in the prerenderer). Never hand this to v-html.

// Derived from the store URL the share pages already link to, so there is one
// app id in this codebase rather than two that can disagree.
const sharing = require("../sharing");

const APP_ID =
  process.env.IOS_APP_ID ||
  (sharing.APP_STORE_URL.match(/\/id(\d+)/) || [])[1] ||
  "6760504694";

const FEED_URL =
  `https://itunes.apple.com/us/rss/customerreviews/id=${APP_ID}` +
  `/sortby=mostrecent/json`;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// After a failure, don't re-attempt for this long. Without it a cold cache (the
// state after every pm2 reload) plus an Apple outage means EVERY visitor
// triggers its own 5s outbound fetch — the marketing page turning a third
// party's downtime into sustained load on a one-vCPU droplet.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000; // 5m
const FETCH_TIMEOUT_MS = 5000;
const MAX_REVIEWS = 20;
const MAX_BODY_CHARS = 240;

// Per-process. pm2 runs a small cluster, so the worst case is one upstream call
// per worker per window — a handful of requests a day, not per visitor.
let cache = { at: 0, reviews: null, failedAt: 0 };

// The single in-flight fetch. Without this, N visitors arriving together on a
// cold cache each start their own upstream call; they all want the same answer,
// so they share one.
let inflight = null;

function truncate(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_BODY_CHARS) return clean;
  const cut = clean.slice(0, MAX_BODY_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 80 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

// Apple's JSON feed is the Atom feed mechanically converted, so every field is
// wrapped as { label }. The FIRST entry is the app record itself, not a review
// — it has no im:rating, which is what we key off rather than a positional
// slice, because an empty feed has no such entry to skip.
function parseFeed(payload) {
  const entries = payload && payload.feed && payload.feed.entry;
  if (!Array.isArray(entries)) return [];

  const reviews = [];
  for (const entry of entries) {
    if (!entry || !entry["im:rating"]) continue;

    const rating = Number(entry["im:rating"].label);
    if (rating !== 5) continue;

    const body = truncate(entry.content && entry.content.label);
    if (!body) continue;

    reviews.push({
      // Prefixed so a synthesized fallback id can never collide with a real
      // Apple one — these become Vue :keys.
      id: String((entry.id && entry.id.label) || `local-${reviews.length}`),
      // Slice BEFORE truncate, so truncate's ellipsis is not itself sliced off.
      title: truncate(String((entry.title && entry.title.label) || "").slice(0, 80)),
      body,
      author: String(
        (entry.author && entry.author.name && entry.author.name.label) || ""
      ).slice(0, 40),
      rating,
    });
    if (reviews.length >= MAX_REVIEWS) break;
  }
  return reviews;
}

async function fetchFeed() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(FEED_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`App Store feed responded ${res.status}`);
    return parseFeed(await res.json());
  } finally {
    clearTimeout(timer);
  }
}

// Returns { reviews }. On an upstream failure the last good payload is served
// REGARDLESS of age — a stale review is strictly better than an empty strip —
// and only a never-warmed cache yields [].
async function getFiveStarReviews({ now = Date.now, fetchImpl = fetchFeed } = {}) {
  if (cache.reviews && now() - cache.at < CACHE_TTL_MS) {
    return { reviews: cache.reviews };
  }
  // Recently failed: serve what we have and don't hammer a struggling upstream.
  if (cache.failedAt && now() - cache.failedAt < FAILURE_BACKOFF_MS) {
    return { reviews: cache.reviews || [] };
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const reviews = await fetchImpl();
      cache = { at: now(), reviews, failedAt: 0 };
      return { reviews };
    } catch (err) {
      // Deliberately swallowed: see the "never throws" note above. The stamp is
      // what stops the next request re-running this straight away.
      console.warn(`[reviews] App Store feed unavailable: ${err.message}`);
      cache = { ...cache, failedAt: now() };
      return { reviews: cache.reviews || [] };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

function resetCacheForTests() {
  cache = { at: 0, reviews: null, failedAt: 0 };
  inflight = null;
}

module.exports = {
  getFiveStarReviews,
  parseFeed,
  resetCacheForTests,
  FEED_URL,
  CACHE_TTL_MS,
};
