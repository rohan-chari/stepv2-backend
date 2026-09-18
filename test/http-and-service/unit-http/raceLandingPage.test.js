const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderRaceLandingPage,
  renderRaceNotFoundPage,
} = require("../../src/modules/web/raceLandingPage");

function makePreview(overrides = {}) {
  return {
    id: "race-1",
    name: "Weekend Warriors",
    status: "PENDING",
    participantCount: 3,
    maxParticipants: 10,
    host: { displayName: "Rohan", profilePhotoUrl: null },
    isJoinable: true,
    ...overrides,
  };
}

const links = {
  shareUrl: "https://steptracker-api.org/r/tok-abc",
  appDeepLink: "bara://join/tok-abc",
  appStoreUrl: "https://apps.apple.com/app/bara",
  playStoreUrl: "https://play.google.com/store/apps/details?id=x",
};

test("landing page shows the race name and host", () => {
  const html = renderRaceLandingPage(makePreview(), links);
  assert.match(html, /Weekend Warriors/);
  assert.match(html, /Rohan/);
});

test("landing page sets Open Graph tags for a rich iMessage preview", () => {
  const html = renderRaceLandingPage(makePreview(), links);
  assert.match(html, /<meta property="og:title"/);
  assert.match(html, /<meta property="og:description"/);
});

test("landing page emits og:image and a large card when an image is configured", () => {
  const html = renderRaceLandingPage(makePreview(), {
    ...links,
    ogImageUrl: "https://steptracker-api.org/share-card.png",
  });
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/steptracker-api\.org\/share-card\.png"/
  );
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
});

test("landing page omits og:image (text-only summary) when no image is configured", () => {
  const html = renderRaceLandingPage(makePreview(), links);
  assert.doesNotMatch(html, /og:image/);
  assert.match(html, /<meta name="twitter:card" content="summary"/);
});

test("landing page links the App Store and deep link; Play button is disabled", () => {
  const html = renderRaceLandingPage(makePreview(), links);
  assert.match(html, /https:\/\/apps\.apple\.com\/app\/bara/);
  // Google Play isn't live yet: a disabled button, no store link.
  assert.doesNotMatch(html, /play\.google\.com/);
  assert.match(html, /store-btn-disabled/);
  assert.match(html, /bara:\/\/join\/tok-abc/);
});

test("landing page escapes a race name containing HTML (no XSS injection)", () => {
  const html = renderRaceLandingPage(
    makePreview({ name: '<script>alert(1)</script>' }),
    links
  );
  // The raw script tag must NOT appear; it must be entity-escaped.
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;/);
});

test("landing page escapes a malicious host display name", () => {
  const html = renderRaceLandingPage(
    makePreview({ host: { displayName: '"><img src=x onerror=y>', profilePhotoUrl: null } }),
    links
  );
  assert.doesNotMatch(html, /<img src=x onerror=y>/);
});

test("not-found page renders a friendly 404 body", () => {
  const html = renderRaceNotFoundPage(links);
  assert.match(html, /<!DOCTYPE html>/i);
  assert.match(html, /not found|no longer/i);
});

// The wordmark lockup. wordmarkParity.test.js proves the two SOURCE copies
// agree; this proves the shell actually renders one — a dropped
// ${theme.WORDMARK_STYLES} or ${theme.wordmarkHtml()} interpolation would
// otherwise ship an unstyled or missing logo with every test still green.
test("landing pages render the Bara wordmark lockup", () => {
  for (const html of [
    renderRaceLandingPage(makePreview(), links),
    renderRaceNotFoundPage(links),
  ]) {
    assert.match(html, /aria-label="Bara: Step Challenges"/);
    assert.match(html, /\/icon-192\.png/);
    // The styles must be injected too, not just the markup.
    assert.match(html, /\.wordmark-text \{ font-family:var\(--font-wordmark\)/);
    // And the face itself must actually be requested.
    assert.match(html, /Jersey\+25/);
  }
});
