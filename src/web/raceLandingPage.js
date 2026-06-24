// Server-rendered landing page for a shared race link (GET /r/:token).
//
// Two audiences hit this URL:
//   * App installed -> the OS intercepts the universal/app link and opens the
//     app directly; this HTML is never seen.
//   * No app -> the browser renders this page: race name + host + player count,
//     Open Graph tags (so the iMessage bubble shows a rich preview), and store
//     buttons. After install, the "Open in app" button (custom-scheme deep
//     link) reliably re-launches into the join flow.
//
// The race name and host display name are user-controlled, so EVERYTHING
// interpolated into the markup is HTML-escaped to prevent injection/XSS.

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell({ title, description, body, links }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  // og:image is optional — emitted only when a share-card URL is configured, so
  // we never advertise an image that 404s. When present, upgrade the Twitter
  // card to the large (image) format; otherwise stay on the text-only summary.
  const ogImage = links && links.ogImageUrl ? escapeHtml(links.ogImageUrl) : "";
  const imageMeta = ogImage
    ? `<meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content="${ogImage}" />
  `
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <meta property="og:title" content="${safeTitle}" />
  <meta property="og:description" content="${safeDescription}" />
  <meta property="og:type" content="website" />
  ${imageMeta}<meta name="twitter:card" content="${ogImage ? "summary_large_image" : "summary"}" />
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           display: flex; min-height: 100vh; align-items: center; justify-content: center;
           background: #0e1116; color: #f5f7fa; padding: 24px; box-sizing: border-box; }
    .card { width: 100%; max-width: 420px; text-align: center; }
    h1 { font-size: 1.6rem; margin: 0 0 8px; }
    .sub { opacity: 0.75; margin: 0 0 24px; font-size: 1rem; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 18px; margin: 10px 0;
           border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 1rem; }
    .btn-primary { background: #f5a623; color: #1a1205; }
    .btn-store { background: #1f2630; color: #f5f7fa; }
  </style>
</head>
<body>
  <main class="card">
    ${body}
    <a class="btn btn-primary" href="${escapeHtml(links.appDeepLink)}">Open in app</a>
    <a class="btn btn-store" href="${escapeHtml(links.appStoreUrl)}">Download on the App Store</a>
    <a class="btn btn-store" href="${escapeHtml(links.playStoreUrl)}">Get it on Google Play</a>
  </main>
</body>
</html>`;
}

function renderRaceLandingPage(preview, links) {
  const hostName =
    preview.host && preview.host.displayName
      ? preview.host.displayName
      : "A friend";
  const playerLine =
    preview.maxParticipants != null
      ? `${preview.participantCount}/${preview.maxParticipants} players`
      : `${preview.participantCount} players`;

  const title = `${preview.name} — join the race on Bara`;
  const description = `${hostName} invited you to "${preview.name}". ${playerLine}. Tap to join.`;

  const body = `
    <h1>${escapeHtml(hostName)} invited you to a step race</h1>
    <p class="sub">${escapeHtml(preview.name)} · ${escapeHtml(playerLine)}</p>
  `;

  return shell({ title, description, body, links });
}

function renderRaceNotFoundPage(links) {
  const body = `
    <h1>Race not found</h1>
    <p class="sub">This race link is no longer valid. Download Bara to start your own step race.</p>
  `;
  return shell({
    title: "Race not found — Bara",
    description: "This race link is no longer valid.",
    body,
    links,
  });
}

module.exports = { renderRaceLandingPage, renderRaceNotFoundPage, escapeHtml };
