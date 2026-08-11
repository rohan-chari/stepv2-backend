const assert = require("node:assert/strict");
const test = require("node:test");

const {
  renderTournamentLandingPage,
  renderTournamentNotFoundPage,
} = require("../../src/modules/web/tournamentLandingPage");

// Item 4: the dedicated tournament landing page (GET /t/ fallback). It must use
// tournament-specific copy + the TOURNAMENT custom-scheme deep link (not the
// race one), carry the store buttons, and HTML-escape user-controlled fields.

const LINKS = {
  shareUrl: "https://steptracker-api.org/t/ABC",
  appDeepLink: "bara://tournament/ABC",
  appStoreUrl: "https://apps.apple.com/app/id6760504694",
  playStoreUrl: "https://play.google.com/store/apps/details?id=com.rohanchari.steptracker",
  ogImageUrl: "",
};

test("renders bracket copy + the tournament custom-scheme deep link", () => {
  const html = renderTournamentLandingPage(
    { name: "Daily Dash", host: { displayName: "Rohan" }, participantCount: 3, bracketSize: 8 },
    LINKS
  );
  assert.match(html, /bara:\/\/tournament\/ABC/, "uses the tournament deep link");
  assert.ok(!html.includes("bara://join/"), "does NOT use the race join deep link");
  assert.match(html, /tournament/i);
  assert.match(html, /3\/8 in the bracket/);
  assert.match(html, /Rohan/);
  assert.match(html, /Daily Dash/);
  assert.match(html, /App Store/);
});

test("escapes user-controlled tournament name + host (XSS-safe)", () => {
  const html = renderTournamentLandingPage(
    { name: "<script>x</script>", host: { displayName: "<b>hax</b>" }, participantCount: 1, bracketSize: 4 },
    LINKS
  );
  assert.ok(!html.includes("<script>x</script>"));
  assert.match(html, /&lt;script&gt;/);
});

test("falls back to a friendly host name + count when fields are missing", () => {
  const html = renderTournamentLandingPage({ name: "Bracket", participantCount: 0 }, LINKS);
  assert.match(html, /A friend/);
  assert.match(html, /0 in the bracket/);
});

test("not-found page renders with the store buttons", () => {
  const html = renderTournamentNotFoundPage(LINKS);
  assert.match(html, /Tournament not found/i);
  assert.match(html, /App Store/);
});

// Same guard as raceLandingPage.test.js: the tournament page reuses that
// module's shell, so a change there must keep the lockup on this page too.
test("tournament pages render the Bara wordmark lockup", () => {
  for (const html of [
    renderTournamentLandingPage({ name: "Bracket", participantCount: 4 }, LINKS),
    renderTournamentNotFoundPage(LINKS),
  ]) {
    assert.match(html, /aria-label="Bara: Step Challenges"/);
    assert.match(html, /\/icon-192\.png/);
    assert.match(html, /Jersey\+25/);
  }
});
