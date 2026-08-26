const theme = require("./theme");

function renderWebsiteNotFoundPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>This page couldn’t be found · Bara</title>
  ${theme.FONT_LINK_TAGS}
  ${theme.ICON_LINK_TAGS}
  <style>
    ${theme.rootStyleBlock()}
    ${theme.WORDMARK_STYLES}
    *{box-sizing:border-box} body{margin:0;min-height:100vh;background:var(--background);color:var(--foreground);font-family:var(--font-body);display:grid;place-items:center;padding:24px}
    main{width:min(560px,100%);text-align:center;display:grid;gap:22px;justify-items:center}
    .art{width:min(360px,82vw);border-radius:calc(var(--radius) * 2);box-shadow:0 12px 0 var(--bara-canopy-deep);border:2px solid var(--border)}
    h1{font-family:var(--font-display);font-size:clamp(2.2rem,8vw,4rem);line-height:1;margin:0}
    p{font-size:1.05rem;color:var(--muted-foreground);margin:0;max-width:42ch}
    a.home{display:inline-block;background:var(--primary);color:var(--primary-foreground);font-family:var(--font-display);font-weight:800;text-decoration:none;padding:14px 24px;border-radius:var(--radius);box-shadow:0 5px 0 var(--bara-canopy-deep)}
  </style>
</head>
<body><main>
  ${theme.wordmarkHtml()}
  <img class="art" src="/share-card.png" alt="Bara the capybara" />
  <h1>This page couldn’t be found</h1>
  <p>This trail wandered off the map. Head home and pick up the path again.</p>
  <a class="home" href="/">Home</a>
</main></body>
</html>`;
}

module.exports = { renderWebsiteNotFoundPage };
