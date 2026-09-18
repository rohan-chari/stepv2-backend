const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { readFileSync } = require("node:fs");
const path = require("node:path");

const theme = require("../../../src/modules/web/theme");

// The "Bara: Step Challenges" lockup exists TWICE by necessity: once as a runtime
// template string in theme.js (for the three server-rendered share-link pages,
// which are plain Express string templates) and once as a Vue SFC (for the built
// marketing site, which is a Tailwind build pipeline). They cannot import each
// other.
//
// This is a structural guard over source text — the case CLAUDE.md allows a unit
// test for, because the property is "these two files agree", which no single
// request through the public path can observe.
//
// It is the SECOND half of the coverage, not the whole of it. That the pages
// actually render a lockup is asserted over the real output elsewhere:
//   * share pages  — test/http/raceLandingPage.test.js and
//                    tournamentLandingPage.test.js
//   * built site   — test/integration/marketing-site.test.js
// Those catch a dropped interpolation; this catches the two copies drifting
// apart while both still render something.
//
// If this fails, do not weaken it: update whichever copy drifted.

const WORDMARK_VUE = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "web",
  "src",
  "components",
  "BaraWordmark.vue"
);

describe("wordmark lockup parity (theme.js vs BaraWordmark.vue)", () => {
  const serverHtml = theme.wordmarkHtml();
  const vueSource = readFileSync(WORDMARK_VUE, "utf8");

  it("uses the same accessible name in both copies", () => {
    const NAME = 'aria-label="Bara: Step Challenges"';
    assert.ok(serverHtml.includes(NAME), "theme.wordmarkHtml() lost the accessible name");
    assert.ok(vueSource.includes(NAME), "BaraWordmark.vue lost the accessible name");
  });

  it("points both copies at the same served icon file", () => {
    // Not a bundled asset: one unhashed file express serves, so a new app icon
    // lands on every surface at once.
    assert.ok(serverHtml.includes("/icon-192.png"));
    assert.ok(vueSource.includes("/icon-192.png"));
  });

  it("splits the visible text the same way in both copies", () => {
    // "Bara" always shows; ": Step Challenges" is the part that drops out on a
    // narrow viewport. Both copies must agree on where the string breaks, or the
    // two surfaces truncate to different words.
    assert.ok(serverHtml.includes(">Bara<"), "theme.js should render a bare 'Bara' span");
    assert.ok(serverHtml.includes(": Step Challenges"));
    assert.ok(vueSource.includes("Bara<span"), "BaraWordmark.vue should render a bare 'Bara'");
    assert.ok(vueSource.includes(": Step Challenges"));
  });

  it("keeps the wordmark on the app's own title face in both copies", () => {
    // Jersey 25 is the whole point of the change — it is what the app sets its
    // title screen in. The server copy reaches it via var(--font-wordmark);
    // the Vue copy via Tailwind's font-wordmark utility, which is generated
    // from the same token.
    assert.match(theme.FONT_WORDMARK, /Jersey 25/);
    assert.ok(theme.FONT_LINK_TAGS.includes("Jersey+25"), "the webfont is never requested");
    assert.ok(theme.WORDMARK_STYLES.includes("var(--font-wordmark)"));
    assert.ok(vueSource.includes("font-wordmark"));

    // The Vue side reaches the token through Tailwind's font-* namespace, which
    // only exists if generate-theme-css.mjs maps it inside `@theme inline`.
    // Grepping the SFC alone would still pass with that mapping deleted — the
    // class would just resolve to nothing and the wordmark would silently fall
    // back to the body font.
    const tokensCss = readFileSync(
      path.join(__dirname, "..", "..", "..", "web", "src", "styles", "tokens.css"),
      "utf8"
    );
    const themeBlock = tokensCss.slice(tokensCss.indexOf("@theme inline"));
    assert.match(
      themeBlock,
      /--font-wordmark:\s*var\(--font-wordmark\);/,
      "@theme inline must map --font-wordmark, or the font-wordmark utility resolves to nothing"
    );
  });

  it("emits --font-wordmark in the runtime :root block", () => {
    // rootStyleBlock() is injected straight into each landing page's <style>.
    // Without this declaration the share pages fall back to the display face
    // while the built site keeps Jersey 25 — a silent, one-sided drift.
    assert.match(theme.rootStyleBlock(), /--font-wordmark:\s*'Jersey 25'/);
  });
});
