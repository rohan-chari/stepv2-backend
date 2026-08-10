// ── Bara web theme: the single source of truth for design tokens ─────────────
//
// TWO consumers, one definition:
//   1. The server-rendered share-link landing pages (raceLandingPage.shell,
//      shared by race + tournament, and referralLandingPage.shell) `require`
//      this module and inject `rootStyleBlock()` straight into their <style>.
//   2. The Vite/Vue marketing site in web/, whose `npm run build` first runs
//      scripts/generate-theme-css.mjs to emit web/src/styles/tokens.css from
//      these same values. That file is GENERATED — never hand-edit it.
//
// So: change a colour HERE and both surfaces move together. This exists because
// the old site had one token block copy-pasted into three static HTML files AND
// a second, divergent "Bara trail" palette inside the landing pages — five
// copies, no source of truth.
//
// ── Direction ────────────────────────────────────────────────────────────────
// Bara is a GAME, not a fitness dashboard: your steps move a capybara down a
// trail while friends sabotage you with trail mines and leeches. The palette is
// dusk on that trail — deep canopy dark, lantern gold, ember for the sabotage.
// Deliberately NOT the app's own parchment/sage (that's the in-app world) and
// deliberately not a light marketing page, because a light page sells a health
// utility and this is a competition.
//
// Long-form legal/help copy still needs a light reading surface, so the token
// set carries BOTH: canopy for chrome and hero, parchment for prose. Pages
// choose per section; both are first-class, neither is a "dark mode".
//
// Names follow shadcn's semantic convention (background/foreground, card,
// muted, primary, accent, border, ring) so shadcn-vue components theme
// themselves with no per-component overrides.

const TOKENS = {
  // ── Base: the app's own forest green ──────────────────────────────────────
  // These ARE the app's palette (lib/styles.dart AppColors): roofMid #2E5D47
  // for the ground, roofDark #213128 for the deepest step, roofRidge #77A98B
  // for the soft highlight. The site previously ran a much darker green of its
  // own invention, which read as a different product next to the app.
  "--background": "#2E5D47",
  "--foreground": "#F6EFE1",

  // Raised surfaces, each a step lighter than the one below it.
  "--card": "#356951",
  "--card-foreground": "#F6EFE1",
  "--popover": "#356951",
  "--popover-foreground": "#F6EFE1",

  // ── Primary: lantern gold. The trail, the coin, the CTA. ──────────────────
  "--primary": "#F0B429",
  "--primary-foreground": "#12291F",

  // Secondary — a quiet raised step for inert chrome.
  "--secondary": "#3F7A5C",
  "--secondary-foreground": "#F6EFE1",

  // Muted — supporting copy on the green ground. Lightened along with the
  // background: the old #A8C4B4 was tuned for a near-black green and drops to
  // ~2.9:1 on #2E5D47. This is 5.6:1, past AA for body and for the small mono
  // nav/eyebrow type that uses it.
  "--muted": "#3F7A5C",
  "--muted-foreground": "#CFE0D5",

  // ── Accent: ember. Sabotage energy — powerups, hazards. Used sparingly; ────
  // this is the loudest colour on the page and earns its keep only on the
  // powerup rail.
  "--accent": "#D9552B",
  "--accent-foreground": "#F6EFE1",

  // Destructive — form validation. Distinct from --accent so an error never
  // reads as decoration. This value is for FILLS (a solid button, a badge),
  // where large/bold shapes carry it; it is 3.4:1 on --card, which fails AA for
  // body text.
  "--destructive": "#E4593C",
  "--destructive-foreground": "#F6EFE1",

  // Lines, inputs, focus rings.
  "--border": "#4A8467",
  "--input": "#4A8467",
  "--ring": "#F0B429",

  "--radius": "0.625rem",

  // ── Parchment reading surface (privacy / support prose) ───────────────────
  // A real second surface, not a dark-mode inversion: legal text at length is
  // hostile on a dark ground, and these two pages are mostly text.
  "--paper": "#F6EFE1",
  "--paper-foreground": "#1A2B22",
  "--paper-muted": "#5C6F63",
  "--paper-border": "#DCCFB8",
  "--paper-raised": "#FFFAF0",
  // Accents for text ON the beige surface. --primary (lantern gold) is ~1.7:1
  // against parchment — fine as a button FILL, unreadable as type — so paper
  // pages get their own pair: deep canopy for labels/eyebrows (7.4:1) and a
  // darkened ember for the powerup rail (6.1:1). Both clear AA for small text.
  "--paper-accent": "#2E5D47",
  "--paper-ember": "#9C3617",
  // Error text on the beige surface. --destructive is ~3.6:1 there; this is
  // 6.5:1, so the waitlist validation message clears AA on paper too.
  "--destructive-paper": "#A32516",

  // ── Bara extras ───────────────────────────────────────────────────────────
  // roofRidge and roofDark, straight from the app.
  "--bara-moss": "#77A98B",
  // The deepest step: footer ground, the hard offset under every button, and
  // the label strip on the share-link card. Dark enough to read as a shadow
  // against gold while still being one of the app's own greens.
  "--bara-canopy-deep": "#213128",
  "--bara-shadow": "rgba(15, 30, 22, 0.35)",
};

// ── Type ─────────────────────────────────────────────────────────────────────
// Three roles, three voices:
//   display — Bricolage Grotesque. Quirky, variable, slightly condensed; it has
//     an actual opinion, unlike the geometric sans every product page ships.
//   body    — Instrument Sans. Clean and warm, stays out of the way at length.
//   mono    — Space Mono. The scoreboard voice: step counts, distance ticks,
//     eyebrows, nav. Steps are numbers, so numbers get their own face.
const FONT_DISPLAY = "'Bricolage Grotesque', ui-sans-serif, system-ui, sans-serif";
const FONT_BODY = "'Instrument Sans', ui-sans-serif, system-ui, -apple-system, sans-serif";
const FONT_MONO = "'Space Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

const FONT_LINK_TAGS = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Instrument+Sans:wght@400;500;600&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet" />`;

// The Bara app icon in the browser tab. Absolute, unhashed paths served by
// express (see the iconRoutes block in src/app.js) so the same markup works
// from a runtime-rendered landing page and from the built marketing site.
// theme-color paints Safari/Chrome mobile chrome to match the page.
const ICON_LINK_TAGS = `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <meta name="theme-color" content="${TOKENS["--background"]}" />`;

// Renders the tokens as a `:root { … }` block for direct injection into a
// server-rendered <style>. Values are literal CSS constants defined in this
// file — never user input — so there is nothing to escape.
function rootStyleBlock() {
  const declarations = Object.entries(TOKENS)
    .map(([name, value]) => `      ${name}: ${value};`)
    .join("\n");
  return `:root {
${declarations}
      --font-display: ${FONT_DISPLAY};
      --font-body: ${FONT_BODY};
      --font-mono: ${FONT_MONO};
      color-scheme: dark;
    }`;
}

module.exports = {
  TOKENS,
  FONT_DISPLAY,
  FONT_BODY,
  FONT_MONO,
  FONT_LINK_TAGS,
  ICON_LINK_TAGS,
  rootStyleBlock,
};
