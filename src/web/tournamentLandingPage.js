// Server-rendered landing page for a shared TOURNAMENT link (GET /t/:token).
//
// Parallel to raceLandingPage.js / referralLandingPage.js, but with
// tournament-specific copy and the correct custom-scheme deep link
// (bara://tournament/<token>). Before this existed, /t/ reused the RACE landing
// renderer, so the unavoidable Safari fallback (frozen clients, per-domain "open
// in Safari" preferences, AASA CDN lag) showed generic "step race" copy and a
// race deep link — confusing for a bracket invite. This makes that fallback a
// good, on-brand experience (Item 4).
//
// Two audiences hit this URL:
//   * App installed  -> the OS intercepts the universal/app link and opens the
//     app directly (deep_link_service.dart routes /t/); this HTML is never seen.
//   * No app / association still propagating / per-domain Safari preference set
//     -> the browser renders this page: tournament name + host + bracket size,
//     Open Graph tags, an "Open in app" custom-scheme button, and store buttons.
//
// The tournament name + host display name are user-controlled, so everything
// interpolated into the markup is HTML-escaped (the shared `shell`/`escapeHtml`
// from raceLandingPage do this) to prevent injection/XSS.

const {
  shell,
  pageScript,
  escapeHtml,
} = require("./raceLandingPage");

function renderTournamentLandingPage(preview, links) {
  const hostName =
    preview.host && preview.host.displayName
      ? preview.host.displayName
      : "A friend";

  // bracketSize is the tournament capacity; participantCount is how many have
  // joined. Degrade gracefully if either is missing.
  const bracketSize = preview.bracketSize ?? preview.maxParticipants ?? null;
  const joined = preview.participantCount ?? 0;
  const bracketLine =
    bracketSize != null
      ? `${joined}/${bracketSize} in the bracket`
      : `${joined} in the bracket`;

  const title = `${preview.name} — join the tournament on Bara`;
  const description = `${hostName} invited you to the "${preview.name}" bracket. ${bracketLine}. Tap to join.`;

  const body = `
    <div class="section">Bracket Tournament</div>
    <div class="invite-body">
      <div class="invite-name">${escapeHtml(hostName)} invited you to a tournament</div>
      <div class="invite-sub">${escapeHtml(preview.name)} · ${escapeHtml(bracketLine)}</div>
    </div>
  `;

  const primaryHtml = `<a id="openapp" class="cta-btn" href="${escapeHtml(links.appDeepLink)}">Open in app</a>`;

  return shell({ title, description, body, links, primaryHtml, scriptBody: pageScript() });
}

function renderTournamentNotFoundPage(links) {
  const body = `
    <div class="section">Tournament not found</div>
    <div class="invite-body">
      <div class="invite-name">This tournament link is no longer valid</div>
      <div class="invite-sub">Download Bara to start your own bracket.</div>
    </div>
  `;
  return shell({
    title: "Tournament not found — Bara",
    description: "This tournament link is no longer valid.",
    body,
    links,
    primaryHtml: "",
    scriptBody: pageScript(),
  });
}

module.exports = { renderTournamentLandingPage, renderTournamentNotFoundPage };
