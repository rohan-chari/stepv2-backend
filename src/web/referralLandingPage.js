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
//   * Android — the CTA routes to a Play Store URL with &referrer=<code> baked
//     in, which Play Install Referrer reads deterministically (no clipboard).
//
// inviterName is user-controlled, so it is HTML-escaped. The code is validated
// to ^BARA-[A-Z0-9]+$ upstream, and all URLs are JSON-encoded into the script.
const { escapeHtml } = require("./raceLandingPage");

function shell({ title, description, body, links, scriptBody }) {
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
    .avatar { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; margin: 0 auto 16px; display: block; }
    .btn { display: block; width: 100%; box-sizing: border-box; padding: 14px 18px; margin: 10px 0;
           border: none; cursor: pointer; border-radius: 12px; text-decoration: none; font-weight: 600; font-size: 1rem; }
    .btn-primary { background: #f5a623; color: #1a1205; }
    .btn-store { background: #1f2630; color: #f5f7fa; }
    .copied { opacity: 0; transition: opacity .2s; font-size: .85rem; margin-top: 6px; min-height: 1.1em; }
    .copied.show { opacity: .8; }
  </style>
</head>
<body>
  <main class="card">
    ${body}
    <button id="cta" class="btn btn-primary" type="button">Use my invite &amp; continue</button>
    <div id="copied" class="copied">Invite copied — opening the store…</div>
    <a class="btn btn-store" href="${escapeHtml(links.appStoreUrl)}">Download on the App Store</a>
    <a class="btn btn-store" href="${escapeHtml(links.playStoreUrl)}">Get it on Google Play</a>
  </main>
  <script>${scriptBody}</script>
</body>
</html>`;
}

function ctaScript(links) {
  // All values are server-built and JSON-encoded => safe as JS string literals.
  return `(function(){
  var inviteUrl=${JSON.stringify(links.inviteUrl)};
  var appStore=${JSON.stringify(links.appStoreUrl)};
  var playStore=${JSON.stringify(links.playStoreUrl)};
  var ua=navigator.userAgent||"";
  var isAndroid=/Android/i.test(ua);
  var cta=document.getElementById("cta");
  var copied=document.getElementById("copied");
  function go(){
    try{ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(inviteUrl); } }catch(e){}
    if(copied){ copied.className="copied show"; }
    var dest=isAndroid?playStore:appStore;
    setTimeout(function(){ window.location.href=dest; }, isAndroid?0:450);
  }
  if(cta){ cta.addEventListener("click", function(e){ e.preventDefault(); go(); }); }
})();`;
}

function renderReferralLandingPage(preview, links) {
  const inviterName =
    preview && preview.inviterName ? preview.inviterName : "A friend";
  const title = `${inviterName} invited you to Bara`;
  const description = `Finish your first race and you'll both earn coins. Tap to join ${inviterName} on Bara.`;

  const avatar =
    preview && preview.inviterAvatar
      ? `<img class="avatar" src="${escapeHtml(preview.inviterAvatar)}" alt="" />`
      : "";

  const body = `
    ${avatar}
    <h1>${escapeHtml(inviterName)} invited you to Bara</h1>
    <p class="sub">Finish your first race — you both earn coins. 🏃</p>
  `;

  return shell({ title, description, body, links, scriptBody: ctaScript(links) });
}

function renderReferralNotFoundPage(links) {
  const body = `
    <h1>Invite not found</h1>
    <p class="sub">This invite link is no longer valid. Download Bara to start racing with friends.</p>
  `;
  return shell({
    title: "Invite not found — Bara",
    description: "This invite link is no longer valid.",
    body,
    links,
    scriptBody: ctaScript(links),
  });
}

module.exports = { renderReferralLandingPage, renderReferralNotFoundPage };
