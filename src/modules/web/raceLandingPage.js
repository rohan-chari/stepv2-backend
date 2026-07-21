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
// Styled to match the "Bara trail" theme shared by barastep.com / /support /
// /privacy. Google Play isn't live yet, so its button surfaces an alert instead
// of routing to a Play Store listing.
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

// Google Play isn't live yet — shown when the Play button is tapped, instead of
// routing to a Play Store listing that doesn't exist.
const PLAY_ALERT_MSG =
  "Google Play isn't supported yet — Bara is currently available on the App Store (iOS).";

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
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Russo+One&family=Chakra+Petch:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    :root {
      --parchment:#F5E6C8; --parchment-border:#C0A878;
      --wood-shadow:#4A2F17; --wood-darker:#6B4423; --wood-dark:#8B5E34; --wood-light:#D4A574;
      --sky-top:#97CCE8; --sky-bottom:#C0E4F4; --grass:#3DA83D; --grass-dark:#2D8830;
      --text-dark:#3B2816; --text-mid:#6B5030; --shadow:rgba(74,47,23,0.28);
      --pill-gold:#E2C66F; --pill-gold-dark:#C39A43; --pill-gold-shadow:#8A672B;
      color-scheme: light;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Chakra Petch', sans-serif; color:var(--text-dark); overflow-x:hidden; min-height:100vh; }

    .sky { position:fixed; inset:0; z-index:-2;
      background:linear-gradient(180deg, var(--sky-top) 0%, var(--sky-bottom) 60%, #E8F0E0 80%, var(--grass) 95%, var(--grass-dark) 100%); }
    .clouds { position:fixed; inset:0; z-index:-1; overflow:hidden; }
    .cloud { position:absolute; background:rgba(240,244,248,0.65); border-radius:50%; filter:blur(20px); }
    .cloud:nth-child(1){ width:300px; height:80px; top:8%; left:10%; animation:drift 60s linear infinite; }
    .cloud:nth-child(2){ width:250px; height:60px; top:15%; left:55%; animation:drift 80s linear infinite reverse; }
    .cloud:nth-child(3){ width:200px; height:50px; top:5%; left:75%; animation:drift 70s linear infinite; }
    @keyframes drift { from{transform:translateX(-100px);} to{transform:translateX(100px);} }

    .content { position:relative; z-index:1; max-width:430px; margin:0 auto;
      padding:52px 20px 60px; display:flex; flex-direction:column; align-items:center; gap:22px; }

    .trail-sign { text-align:center; }
    .trail-sign .board-sign { background:linear-gradient(180deg, var(--wood-light), var(--wood-dark));
      padding:14px 40px; border-radius:8px; border:2px solid var(--wood-darker); position:relative;
      box-shadow:3px 4px 10px var(--shadow), inset 0 1px 0 rgba(255,255,255,0.25); }
    .trail-sign .board-sign::before, .trail-sign .board-sign::after { content:''; position:absolute; top:50%;
      transform:translateY(-50%); width:10px; height:10px; background:var(--wood-darker); border-radius:50%;
      box-shadow:inset 0 1px 2px rgba(0,0,0,0.4); }
    .trail-sign .board-sign::before{ left:12px; } .trail-sign .board-sign::after{ right:12px; }
    .trail-sign h1 { font-family:'Russo One', sans-serif; font-size:2.2rem; color:var(--parchment);
      text-shadow:2px 2px 0 var(--wood-shadow); letter-spacing:4px; text-transform:uppercase; }
    .trail-sign .post { width:16px; height:44px; margin:0 auto; border-radius:2px;
      background:linear-gradient(90deg, var(--wood-dark), var(--wood-light), var(--wood-dark)); box-shadow:2px 2px 6px var(--shadow); }

    .board { width:100%; background:linear-gradient(180deg, var(--wood-light) 0%, var(--wood-dark) 100%);
      border:2px solid var(--wood-shadow); border-radius:12px; padding:6px; position:relative;
      box-shadow:0 4px 14px var(--shadow), inset 0 1px 0 rgba(255,255,255,0.18); }
    .board::before { content:''; position:absolute; inset:2px; border-radius:10px; pointer-events:none;
      background-image:repeating-linear-gradient(to bottom, transparent 0 4px, rgba(160,112,64,0.18) 4px 5px); }
    .board-inner { position:relative; background:var(--parchment); border:1px solid var(--parchment-border);
      border-radius:8px; overflow:hidden;
      background-image:radial-gradient(ellipse at 20% 50%, rgba(200,170,110,0.18) 0%, transparent 70%), radial-gradient(ellipse at 80% 30%, rgba(180,150,90,0.12) 0%, transparent 60%); }

    .section { padding:14px 16px 10px; font-family:'Russo One', sans-serif; text-transform:uppercase;
      letter-spacing:1.5px; font-size:0.9rem; color:var(--wood-darker); text-align:center;
      border-bottom:1px solid rgba(139,94,52,0.18); background:rgba(139,94,52,0.05); }

    .invite-body { padding:22px 18px 24px; text-align:center; }
    .invite-name { font-family:'Russo One', sans-serif; font-size:1.2rem; line-height:1.3; color:var(--wood-darker); margin-bottom:8px; }
    .invite-sub { font-size:1rem; line-height:1.5; color:var(--text-mid); }

    .cta-btn { display:flex; align-items:center; justify-content:center; width:100%; padding:16px 22px;
      border:none; cursor:pointer; border-radius:16px; text-decoration:none;
      font-family:'Russo One', sans-serif; font-size:0.95rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-dark);
      background:linear-gradient(180deg, var(--pill-gold) 0%, var(--pill-gold-dark) 100%); box-shadow:0 5px 0 var(--pill-gold-shadow);
      transition:transform .08s ease, box-shadow .08s ease, filter .08s ease; }
    .cta-btn:hover { filter:brightness(1.04); }
    .cta-btn:active { transform:translateY(5px); box-shadow:0 0 0 var(--pill-gold-shadow); }

    .store-buttons { display:flex; flex-direction:column; gap:12px; width:100%; }
    .store-btn { display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
      font-family:'Chakra Petch', sans-serif; font-weight:700; font-size:0.95rem; color:var(--parchment); text-decoration:none;
      padding:14px 18px; border-radius:14px; border:2px solid var(--wood-shadow);
      background:linear-gradient(180deg, var(--wood-light), var(--wood-dark));
      box-shadow:0 4px 10px var(--shadow), inset 0 1px 0 rgba(255,255,255,0.18); transition:filter .08s ease, transform .08s ease; }
    .store-btn:hover { filter:brightness(1.06); }
    .store-btn:active { transform:translateY(2px); }
    .store-btn-disabled { opacity:0.55; filter:grayscale(0.5); cursor:not-allowed; }
    .store-btn-disabled:hover { filter:grayscale(0.5); }
    .store-btn-disabled:active { transform:none; }

    @media (max-width:500px){
      .trail-sign h1 { font-size:1.8rem; }
      .trail-sign .board-sign { padding:12px 30px; }
      .content { padding:40px 16px 48px; gap:18px; }
    }

    @keyframes fadeUp { from{opacity:0; transform:translateY(20px);} to{opacity:1; transform:translateY(0);} }
    .content > * { animation:fadeUp 0.5s ease both; }
    .content > *:nth-child(1){ animation-delay:0.05s; }
    .content > *:nth-child(2){ animation-delay:0.13s; }
    .content > *:nth-child(3){ animation-delay:0.21s; }
    .content > *:nth-child(4){ animation-delay:0.29s; }
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
