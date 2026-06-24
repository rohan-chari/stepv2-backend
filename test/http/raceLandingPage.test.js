const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderRaceLandingPage,
  renderRaceNotFoundPage,
} = require("../../src/web/raceLandingPage");

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

test("landing page links to both stores and the custom-scheme deep link", () => {
  const html = renderRaceLandingPage(makePreview(), links);
  assert.match(html, /https:\/\/apps\.apple\.com\/app\/bara/);
  assert.match(html, /play\.google\.com/);
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
