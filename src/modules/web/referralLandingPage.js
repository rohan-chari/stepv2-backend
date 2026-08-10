// Server-rendered landing page for a referral invite link (GET /r/BARA-xxxx).
//
// Shown only when the app is NOT installed (otherwise the OS routes the
// universal/app link straight into the app). Its job is to (a) show who invited
// them + the reward as a rich OG preview, and (b) hand the referral code off
// across the install gap:
//   * iOS — the CTA copies the FULL invite URL to the clipboard on a user tap
//     (Safari requires a gesture to write), then routes to the App Store. On
//     first launch the app silently detects that URL via
//     UIPasteboard.detectPatterns(.probableWebURL) and one-tap-applies it.
//   * Android — Google Play is not supported yet, so the CTA and the Play
//     button surface an alert instead of routing to a Play Store URL.
//
// Styled from ./theme.js — the SAME token module barastep.com generates its CSS
// from and the race/tournament shell reads, so all three surfaces share one
// palette and typeface. Change a colour there, not here.
//
// inviterName is user-controlled, so it is HTML-escaped. The code is validated
// to ^BARA-[A-Z0-9]+$ upstream, and all URLs are JSON-encoded into the script.
const { escapeHtml } = require("./raceLandingPage");
const theme = require("./theme");

// Google Play isn't live yet — shown when the Play button or the Android CTA is
// tapped, instead of routing to a Play Store listing that doesn't exist.
// Both copies of this string must stay in sync (the other lives in the sibling
// landing-page module) — they are shown by the same disabled-Play-button
// handler on two different pages.
const PLAY_ALERT_MSG =
  "Bara isn't on Android yet — it's on the App Store (iOS) today. " +
  "Join the Android waitlist at barastep.com and we'll email you when it's ready.";

function shell({ title, description, body, links, showCta, scriptBody }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const ogImage = links && links.ogImageUrl ? escapeHtml(links.ogImageUrl) : "";
  const imageMeta = ogImage
    ? `<meta property="og:image" content="${ogImage}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:image" content="${ogImage}" />
  `
    : "";
  const ctaBlock = showCta
    ? `<button id="cta" class="cta-btn" type="button">Use my invite &amp; continue</button>
    <div id="copied" class="copied">Invite copied — opening the App Store…</div>`
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
  ${theme.ICON_LINK_TAGS}
  ${theme.FONT_LINK_TAGS}
  <style>
    ${theme.rootStyleBlock()}
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:var(--font-body); background:var(--background); color:var(--foreground);
      overflow-x:hidden; min-height:100vh; -webkit-font-smoothing:antialiased; }

    /* Dusk under the canopy — same treatment as the race/tournament shell in
       raceLandingPage.js. Both read their values from ./theme.js. */
    .sky { position:fixed; inset:0; z-index:-2; background:var(--background); }
    .clouds { position:fixed; inset:0; z-index:-1; overflow:hidden; }
    .cloud { position:absolute; background:var(--bara-moss); opacity:0.07; border-radius:50%; filter:blur(60px); }
    .cloud:nth-child(1){ width:340px; height:200px; top:2%; left:-8%; animation:drift 60s linear infinite; }
    .cloud:nth-child(2){ width:300px; height:180px; top:38%; left:60%; animation:drift 80s linear infinite reverse; }
    .cloud:nth-child(3){ width:260px; height:160px; top:72%; left:12%; animation:drift 70s linear infinite; }
    @keyframes drift { from{transform:translateX(-60px);} to{transform:translateX(60px);} }

    .content { position:relative; z-index:1; max-width:430px; margin:0 auto;
      padding:52px 20px 60px; display:flex; flex-direction:column; align-items:center; gap:22px; }

    .trail-sign { text-align:center; }
    .trail-sign .board-sign { padding:0 0 2px; }
    .trail-sign h1 { font-family:var(--font-display); font-weight:800; font-size:2.4rem;
      letter-spacing:-0.03em; color:var(--foreground); }
    .trail-sign .post { width:2px; height:34px; margin:10px auto 0;
      background-image:repeating-linear-gradient(to bottom, var(--border) 0 6px, transparent 6px 12px); }

    .board { width:100%; background:var(--card); border:1px solid var(--border); border-radius:var(--radius);
      padding:0; position:relative; overflow:hidden; box-shadow:0 10px 30px var(--bara-shadow); }
    .board-inner { position:relative; }

    /* The label strip sits on the DEEPEST green, not --secondary: gold on
       --secondary is ~2.7:1, which this 0.72rem mono type cannot carry. On
       --bara-canopy-deep it is 7.3:1. */
    .section { padding:14px 18px; font-family:var(--font-mono); text-transform:uppercase;
      letter-spacing:0.18em; font-size:0.72rem; color:var(--primary); text-align:center;
      border-bottom:1px solid var(--border); background:var(--bara-canopy-deep); }

    .invite-body { padding:26px 20px 28px; text-align:center; }
    .avatar { width:76px; height:76px; border-radius:50%; object-fit:cover; display:block; margin:0 auto 16px;
      border:2px solid var(--primary); box-shadow:0 4px 12px var(--bara-shadow); }
    .invite-name { font-family:var(--font-display); font-weight:800; font-size:1.35rem; line-height:1.25;
      letter-spacing:-0.02em; color:var(--foreground); margin-bottom:10px; }
    .invite-sub { font-size:1rem; line-height:1.55; color:var(--muted-foreground); }

    .cta-btn { width:100%; padding:16px 22px; border:none; cursor:pointer; border-radius:var(--radius);
      font-family:var(--font-display); font-weight:700; font-size:1rem; letter-spacing:-0.01em;
      color:var(--primary-foreground); background:var(--primary); box-shadow:0 4px 0 var(--bara-canopy-deep);
      transition:transform .08s ease, box-shadow .08s ease, filter .08s ease; }
    .cta-btn:hover { filter:brightness(1.05); }
    .cta-btn:active { transform:translateY(4px); box-shadow:0 0 0 var(--bara-canopy-deep); }
    .copied { opacity:0; transition:opacity .2s; font-size:.85rem; color:var(--muted-foreground);
      min-height:1.1em; margin-top:-10px; }
    .copied.show { opacity:1; }

    .store-buttons { display:flex; flex-direction:column; gap:12px; width:100%; }
    .store-btn { display:inline-flex; align-items:center; justify-content:center; cursor:pointer;
      font-family:var(--font-display); font-weight:700; font-size:0.95rem; color:var(--foreground); text-decoration:none;
      padding:14px 18px; border-radius:var(--radius); border:1px solid var(--border);
      background:var(--secondary); box-shadow:0 3px 0 var(--bara-canopy-deep);
      transition:filter .08s ease, transform .08s ease; }
    .store-btn:hover { filter:brightness(1.12); }
    .store-btn:active { transform:translateY(3px); box-shadow:0 0 0 var(--bara-canopy-deep); }
    /* Google Play isn't live yet — visible but inert; the click handler explains. */
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
    .content > *:nth-child(5){ animation-delay:0.37s; }

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
    ${ctaBlock}
    <div class="store-buttons">
      <a id="appstore" class="store-btn" href="${escapeHtml(links.appStoreUrl)}">Download on the App Store</a>
      <button id="playstore" class="store-btn store-btn-disabled" type="button" aria-disabled="true">Get it on Google Play</button>
    </div>
  </main>
  <script>${scriptBody}</script>
</body>
</html>`;
}

function pageScript(links) {
  // All values are server-built and JSON-encoded => safe as JS string literals.
  return `(function(){
  var inviteUrl=${JSON.stringify(links.inviteUrl)};
  var appStore=${JSON.stringify(links.appStoreUrl)};
  var PLAY_MSG=${JSON.stringify(PLAY_ALERT_MSG)};
  var ua=navigator.userAgent||"";
  var isAndroid=/Android/i.test(ua);
  var cta=document.getElementById("cta");
  var copied=document.getElementById("copied");
  var play=document.getElementById("playstore");
  function copyInvite(){ try{ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(inviteUrl); } }catch(e){} }
  if(cta){ cta.addEventListener("click", function(e){
    e.preventDefault();
    if(isAndroid){ alert(PLAY_MSG); return; }
    copyInvite();
    if(copied){ copied.className="copied show"; }
    setTimeout(function(){ window.location.href=appStore; }, 450);
  }); }
  if(play){ play.addEventListener("click", function(e){ e.preventDefault(); alert(PLAY_MSG); }); }
})();`;
}

function renderReferralLandingPage(preview, links) {
  const inviterName =
    preview && preview.inviterName ? preview.inviterName : "A friend";
  const title = `${inviterName} invited you to Bara`;
  // Batch 2026-08-09 item 2: the qualifying race is now a NON-SEEDED race with
  // at least one other real player who logs steps. Official daily/weekly
  // challenges no longer count, so the copy must not promise otherwise.
  const description = `Race a friend and you'll both earn coins. Tap to join ${inviterName} on Bara.`;

  const avatar =
    preview && preview.inviterAvatar
      ? `<img class="avatar" src="${escapeHtml(preview.inviterAvatar)}" alt="" />`
      : "";

  const body = `
    <div class="section">You're Invited</div>
    <div class="invite-body">
      ${avatar}
      <div class="invite-name">${escapeHtml(inviterName)} invited you to Bara</div>
      <div class="invite-sub">Finish a race with friends — you both earn coins. Daily &amp; weekly challenges don't count.</div>
    </div>
  `;

  return shell({ title, description, body, links, showCta: true, scriptBody: pageScript(links) });
}

function renderReferralNotFoundPage(links) {
  const body = `
    <div class="section">Invite not found</div>
    <div class="invite-body">
      <div class="invite-name">This invite link is no longer valid</div>
      <div class="invite-sub">Download Bara to start racing with friends.</div>
    </div>
  `;
  return shell({
    title: "Invite not found — Bara",
    description: "This invite link is no longer valid.",
    body,
    links,
    showCta: false,
    scriptBody: pageScript(links),
  });
}

module.exports = { renderReferralLandingPage, renderReferralNotFoundPage };
