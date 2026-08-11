// Post-build guard for the ONE mistake that silently ships a broken site.
//
// The Express app mounts the game-art CDN at /assets with `fallthrough: false`
// (src/app.js), which turns any unmatched /assets/* request into a hard 404. If
// Vite ever emits its bundles under the default `assets` directory, every JS and
// CSS URL in the built HTML lands in that 404 — the page still returns 200 and
// still renders, just with no styles and no working waitlist form. That failure
// looks like a CSS bug, not a routing bug, and it would reach production.
//
// vite.config.js pins build.assetsDir to "web-assets". This asserts the build
// actually honoured it, and fails the build loudly if not.

import { createRequire } from "node:module";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const theme = require(join(here, "..", "..", "src", "modules", "web", "theme.js"));

const problems = [];

if (!existsSync(join(distDir, "web-assets"))) {
  problems.push(
    'dist/web-assets/ does not exist — build.assetsDir is not "web-assets".'
  );
}

if (existsSync(join(distDir, "assets"))) {
  problems.push(
    "dist/assets/ exists — those files collide with the CDN art mount and will 404."
  );
}

// Each page must contain real prose in its SHIPPED HTML, not just a mount
// point. This is the regression guard for scripts/prerender.mjs: if prerender
// is skipped or silently fails, /privacy (the App Store listing's URL) becomes
// a blank page that still returns 200, which is invisible in any status check.
const REQUIRED_PROSE = {
  "index.html": "more fun when you can steal",
  "privacy.html": "not write to or modify your health data",
  "support.html": "Common trail troubles",
};

for (const page of ["index.html", "privacy.html", "support.html"]) {
  const file = join(distDir, page);
  if (!existsSync(file)) {
    problems.push(`dist/${page} is missing — the Express route for it would 500.`);
    continue;
  }
  const html = readFileSync(file, "utf8");
  // Matches src="/assets/... or href="/assets/... — the collision case. A
  // reference to /web-assets/ is fine and must not trip this.
  if (/["'(]\/assets\//.test(html)) {
    problems.push(`dist/${page} references /assets/ — those URLs will 404.`);
  }
  if (!html.includes(REQUIRED_PROSE[page])) {
    problems.push(
      `dist/${page} is missing its prerendered copy ("${REQUIRED_PROSE[page]}") — ` +
        `the page would render blank without JavaScript. Did prerender.mjs run?`
    );
  }
  if (html.includes('<div id="app"></div>')) {
    problems.push(
      `dist/${page} still has an EMPTY mount point — prerender.mjs did not fill it.`
    );
  }

  // The app-icon links are authored by hand in each entry HTML (they point at
  // stable express-served paths, so Vite never rewrites them). Assert they are
  // actually present, and that the hand-written theme-color still matches the
  // token it mirrors — this is the one value that can silently drift from
  // theme.js, because unlike the palette it isn't generated.
  if (!html.includes('href="/favicon-32.png"')) {
    problems.push(`dist/${page} is missing its favicon link.`);
  }
  if (!html.includes('href="/apple-touch-icon.png"')) {
    problems.push(`dist/${page} is missing its apple-touch-icon link.`);
  }
  // The wordmark is set in Jersey 25 — the app's own title face — which is
  // fetched from Google Fonts via theme.FONT_LINK_TAGS. If that request line
  // ever loses the family, the wordmark silently falls back to Bricolage and
  // the site stops matching the app, with nothing else breaking to signal it.
  if (!html.includes("Jersey+25")) {
    problems.push(
      `dist/${page} does not request the Jersey 25 webfont — the wordmark would ` +
        `fall back to the display face. Check FONT_LINK_TAGS in theme.js.`
    );
  }

  // The review belt animates translateX(0 -> -50%), which is seamless ONLY if
  // the track is exactly two identical halves. Get that wrong and it scrolls
  // partway and hard-resets — visible on every loop, and invisible to every
  // test that only asks whether reviews are present. Checked on the SHIPPED
  // html because that is the artifact that has to be right.
  if (page === "index.html") {
    const track = html.match(/<div class="marquee"[^>]*>([\s\S]*?)<\/div><\/div>/);
    if (!track) {
      problems.push(
        "dist/index.html has no review marquee track — the strip would be missing entirely."
      );
    } else {
      const cards = track[1].split('<div class="mr-4').slice(1);
      if (cards.length < 2 || cards.length % 2 !== 0) {
        problems.push(
          `dist/index.html marquee has ${cards.length} cards — it must be an EVEN ` +
            `count (two identical halves) or the -50% loop visibly snaps.`
        );
      } else {
        // Strip Vue's SSR fragment anchors (<!--[-->, <!--]-->, <!---->) before
        // comparing: renderToString brackets a v-for list with them, so the
        // LAST card of the track carries a closing anchor the middle card does
        // not. That is hydration machinery, not content, and comparing it would
        // make this guard fail on a perfectly correct track.
        const strip = (s) => s.replace(/<!--(\[|\]|)-->/g, "");
        const half = cards.length / 2;
        const first = strip(cards.slice(0, half).join(""));
        const second = strip(cards.slice(half).join(""));
        if (first !== second) {
          problems.push(
            "dist/index.html marquee's two halves differ — the -50% loop will jump. " +
              "The track must be one list rendered exactly twice."
          );
        }
      }
    }
  }

  const themeColor = html.match(/<meta name="theme-color" content="([^"]+)"/);
  if (!themeColor) {
    problems.push(`dist/${page} is missing its theme-color meta.`);
  } else if (
    themeColor[1].toUpperCase() !== theme.TOKENS["--background"].toUpperCase()
  ) {
    problems.push(
      `dist/${page} theme-color is ${themeColor[1]} but theme.js --background is ` +
        `${theme.TOKENS["--background"]} — update the <meta> in web/${page}.`
    );
  }
}

if (problems.length > 0) {
  console.error("\n[check-build-output] BUILD REJECTED:\n");
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  process.exit(1);
}

const bundles = existsSync(join(distDir, "web-assets"))
  ? readdirSync(join(distDir, "web-assets")).length
  : 0;
console.log(
  `[check-build-output] ok — 3 pages, ${bundles} bundled asset(s) under /web-assets.`
);
