// Server-rendered landing page for a shared race link (GET /r/:token).
//
// Two audiences hit this URL:
//   * App installed -> the OS intercepts the universal/app link and opens the
//     app directly; this HTML is never seen.
//   * No app -> the browser renders this page: race name + host + player count,
//     Open Graph tags (so the iMessage bubble shows a rich preview), and store
//     buttons. The "Open in app" button (custom-scheme deep link) reliably
//     re-launches into the join flow once installed.
//
// Styled from ./theme.js — the SAME token module the built marketing site
// generates its CSS from, so a share link and barastep.com can never drift onto
// different palettes or typefaces. Change a colour there, not here.
//
// Google Play isn't live yet, so its button surfaces an alert instead of routing
// to a Play Store listing.
//
// The race name and host display name are user-controlled, so EVERYTHING
// interpolated into the markup is HTML-escaped to prevent injection/XSS.

const theme = require("./theme");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Google Play isn't live yet — shown when the Play button is tapped, instead of
// routing to a Play Store listing that doesn't exist.
// Both copies of this string must stay in sync (the other lives in the sibling
// landing-page module) — they are shown by the same disabled-Play-button
// handler on two different pages.
const PLAY_ALERT_MSG =
  "Bara isn't on Android yet — it's on the App Store (iOS) today. " +
  "Join the Android waitlist at barastep.com and we'll email you when it's ready.";

function shell({ title, description, body, links, primaryHtml, scriptBody }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  // og:image is optional — emitted only when a share-card URL is configured, so
  // we never advertise an image that 404s.
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
  ${theme.FONT_LINK_TAGS}
  <style>
    ${theme.rootStyleBlock()}
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:var(--font-body); background:var(--background); color:var(--foreground);
      overflow-x:hidden; min-height:100vh; -webkit-font-smoothing:antialiased; }

    /* Dusk under the canopy. The old sky/cloud elements are kept (same markup)
       but now read as depth in the dark, not a daytime sky. */
    .sky { position:fixed; inset:0; z-index:-2; background:var(--background); }
    .clouds { position:fixed; inset:0; z-index:-1; overflow:hidden; }
    .cloud { position:absolute; background:var(--bara-moss); opacity:0.07; border-radius:50%; filter:blur(60px); }
    .cloud:nth-child(1){ width:340px; height:200px; top:2%; left:-8%; animation:drift 60s linear infinite; }
    .cloud:nth-child(2){ width:300px; height:180px; top:38%; left:60%; animation:drift 80s linear infinite reverse; }
    .cloud:nth-child(3){ width:260px; height:160px; top:72%; left:12%; animation:drift 70s linear infinite; }
    @keyframes drift { from{transform:translateX(-60px);} to{transform:translateX(60px);} }

    .content { position:relative; z-index:1; max-width:430px; margin:0 auto;
      padding:52px 20px 60px; display:flex; flex-direction:column; align-items:center; gap:22px; }

    /* The wordmark, plus the dashed trail running down to the invite card. */
    .trail-sign { text-align:center; }
    .trail-sign .board-sign { padding:0 0 2px; }
    .trail-sign h1 { font-family:var(--font-display); font-weight:800; font-size:2.4rem;
      letter-spacing:-0.03em; color:var(--foreground); }
    .trail-sign .post { width:2px; height:34px; margin:10px auto 0;
      background-image:repeating-linear-gradient(to bottom, var(--border) 0 6px, transparent 6px 12px); }

    .board { width:100%; background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
      padding:0; position:relative; overflow:hidden; box-shadow:0 10px 30px var(--bara-shadow); }
    .board-inner { position:relative; }

    .section { padding:14px 18px; font-family:var(--font-mono); text-transform:uppercase;
      letter-spacing:0.18em; font-size:0.72rem; color:var(--primary); text-align:center;
      border-bottom:1px solid var(--border); background:var(--secondary); }

    .invite-body { padding:26px 20px 28px; text-align:center; }
    .invite-name { font-family:var(--font-display); font-weight:800; font-size:1.35rem; line-height:1.25;
      letter-spacing:-0.02em; color:var(--foreground); margin-bottom:10px; }
    .invite-sub { font-size:1rem; line-height:1.55; color:var(--muted-foreground); }

    /* Primary CTA — lantern gold with the hard offset shadow the site's buttons
       use, so a share link feels like the same product as barastep.com. */
    .cta-btn { display:flex; align-items:center; justify-content:center; width:100%; padding:16px 22px;
      border:none; cursor:pointer; border-radius:var(--radius); text-decoration:none;
      font-family:var(--font-display); font-weight:700; font-size:1rem; letter-spacing:-0.01em;
      color:var(--primary-foreground); background:var(--primary); box-shadow:0 4px 0 var(--bara-canopy-deep);
      transition:transform .08s ease, box-shadow .08s ease, filter .08s ease; }
    .cta-btn:hover { filter:brightness(1.05); }
    .cta-btn:active { transform:translateY(4px); box-shadow:0 0 0 var(--bara-canopy-deep); }

    .store-buttons { display:flex; flex-direction:column; gap:12px; width:100%; }
    .store-btn { display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
      font-family:var(--font-display); font-weight:700; font-size:0.95rem; color:var(--foreground); text-decoration:none;
      padding:14px 18px; border-radius:var(--radius); border:1px solid var(--border);
      background:var(--secondary); box-shadow:0 3px 0 var(--bara-canopy-deep);
      transition:filter .08s ease, transform .08s ease; }
    .store-btn:hover { filter:brightness(1.12); }
    .store-btn:active { transform:translateY(3px); box-shadow:0 0 0 var(--bara-canopy-deep); }
    /* Google Play isn't live yet. Kept visible but inert — the click handler in
       pageScript() explains why rather than routing to a listing that 404s. */
    .store-btn-disabled { opacity:0.5; cursor:not-allowed; box-shadow:none; }
    .store-btn-disabled:hover { filter:none; }
    .store-btn-disabled:active { transform:none; box-shadow:none; }

    @media (max-width:500px){
      .trail-sign h1 { font-size:2rem; }
      .content { padding:40px 16px 48px; gap:18px; }
    }

    @keyframes fadeUp { from{opacity:0; transform:translateY(20px);} to{opacity:1; transform:translateY(0);} }
    .content > * { animation:fadeUp 0.5s ease both; }
    .content > *:nth-child(1){ animation-delay:0.05s; }
    .content > *:nth-child(2){ animation-delay:0.13s; }
    .content > *:nth-child(3){ animation-delay:0.21s; }
    .content > *:nth-child(4){ animation-delay:0.29s; }

    @media (prefers-reduced-motion: reduce) {
      .cloud { animation:none; }
      .content > * { animation:none; }
    }
  </style>
</head>
<body>
  <div class="sky"></div>
  <div class="clouds"><div class="cloud"></div><div class="cloud"></div><div class="cloud"></div></div>
  <main class="content">
    <div class="trail-sign"><div class="board-sign"><h1>Bara</h1></div><div class="post"></div></div>
    <div class="board"><div class="board-inner">${body}</div></div>
    ${primaryHtml || ""}
    <div class="store-buttons">
      <a id="appstore" class="store-btn" href="${escapeHtml(links.appStoreUrl)}">Download on the App Store</a>
      <button id="playstore" class="store-btn store-btn-disabled" type="button" aria-disabled="true">Get it on Google Play</button>
    </div>
  </main>
  <script>${scriptBody}</script>
</body>
</html>`;
}

function pageScript() {
  return `(function(){
  var PLAY_MSG=${JSON.stringify(PLAY_ALERT_MSG)};
  var play=document.getElementById("playstore");
  if(play){ play.addEventListener("click", function(e){ e.preventDefault(); alert(PLAY_MSG); }); }
})();`;
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
    <div class="section">Step Race</div>
    <div class="invite-body">
      <div class="invite-name">${escapeHtml(hostName)} invited you to a step race</div>
      <div class="invite-sub">${escapeHtml(preview.name)} · ${escapeHtml(playerLine)}</div>
    </div>
  `;

  const primaryHtml = `<a id="openapp" class="cta-btn" href="${escapeHtml(links.appDeepLink)}">Open in app</a>`;

  return shell({ title, description, body, links, primaryHtml, scriptBody: pageScript() });
}

function renderRaceNotFoundPage(links) {
  const body = `
    <div class="section">Race not found</div>
    <div class="invite-body">
      <div class="invite-name">This race link is no longer valid</div>
      <div class="invite-sub">Download Bara to start your own step race.</div>
    </div>
  `;
  return shell({
    title: "Race not found — Bara",
    description: "This race link is no longer valid.",
    body,
    links,
    primaryHtml: "",
    scriptBody: pageScript(),
  });
}

// `shell` + `pageScript` are exported so the tournament landing page
// (web/tournamentLandingPage.js) reuses the exact same Bara-trail chrome, store
// buttons, and Play-alert script — only the inner copy differs.
module.exports = {
  renderRaceLandingPage,
  renderRaceNotFoundPage,
  escapeHtml,
  shell,
  pageScript,
};
