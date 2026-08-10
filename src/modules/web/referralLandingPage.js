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
// Styled to match the "Bara trail" theme shared by barastep.com / /support /
// /privacy (sky + clouds, wooden trail sign, parchment board, gold pill CTA).
//
// inviterName is user-controlled, so it is HTML-escaped. The code is validated
// to ^BARA-[A-Z0-9]+$ upstream, and all URLs are JSON-encoded into the script.
const { escapeHtml } = require("./raceLandingPage");

// Google Play isn't live yet — shown when the Play button or the Android CTA is
// tapped, instead of routing to a Play Store listing that doesn't exist.
const PLAY_ALERT_MSG =
  "Google Play isn't supported yet — Bara is currently available on the App Store (iOS).";

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
    .avatar { width:76px; height:76px; border-radius:50%; object-fit:cover; display:block; margin:0 auto 14px;
      border:3px solid var(--wood-dark); box-shadow:0 2px 6px var(--shadow); }
    .invite-name { font-family:'Russo One', sans-serif; font-size:1.2rem; line-height:1.3; color:var(--wood-darker); margin-bottom:8px; }
    .invite-sub { font-size:1rem; line-height:1.5; color:var(--text-mid); }

    .cta-btn { width:100%; padding:16px 22px; border:none; cursor:pointer; border-radius:16px;
      font-family:'Russo One', sans-serif; font-size:0.95rem; letter-spacing:1.5px; text-transform:uppercase; color:var(--text-dark);
      background:linear-gradient(180deg, var(--pill-gold) 0%, var(--pill-gold-dark) 100%); box-shadow:0 5px 0 var(--pill-gold-shadow);
      transition:transform .08s ease, box-shadow .08s ease, filter .08s ease; }
    .cta-btn:hover { filter:brightness(1.04); }
    .cta-btn:active { transform:translateY(5px); box-shadow:0 0 0 var(--pill-gold-shadow); }
    .copied { opacity:0; transition:opacity .2s; font-size:.85rem; color:var(--text-mid); min-height:1.1em; margin-top:-10px; }
    .copied.show { opacity:.85; }

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
    .content > *:nth-child(5){ animation-delay:0.37s; }
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
