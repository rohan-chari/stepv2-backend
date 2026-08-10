// Generates web/src/styles/tokens.css from the ONE source of truth:
// src/modules/web/theme.js (a CommonJS module the Express landing pages also
// require at runtime).
//
// Run automatically by `npm run dev` and `npm run build` — you should never
// need to invoke it by hand, and you should never hand-edit the file it writes.
//
// Why generate instead of sharing a .css file: the landing pages are runtime JS
// template strings inside the Express process and the site is a build-time
// Tailwind pipeline. They cannot import the same stylesheet, but they CAN agree
// on the same JS object. This script is that bridge.

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const theme = require(join(here, "..", "..", "src", "modules", "web", "theme.js"));

const tokenLines = Object.entries(theme.TOKENS)
  .map(([name, value]) => `  ${name}: ${value};`)
  .join("\n");

// Tailwind v4 reads its design system from CSS. `@theme inline` maps our tokens
// onto Tailwind's namespaces so `bg-background`, `text-muted-foreground`,
// `font-display` etc. resolve to the values in theme.js — no tailwind.config.js
// duplicating the palette.
const css = `/* GENERATED FILE — DO NOT EDIT.
 *
 * Written by web/scripts/generate-theme-css.mjs from src/modules/web/theme.js.
 * Change a token THERE; both this site and the server-rendered share-link
 * landing pages pick it up. Editing this file by hand gets overwritten on the
 * next build and silently desyncs the two surfaces.
 */

:root {
${tokenLines}
  --font-display: ${theme.FONT_DISPLAY};
  --font-body: ${theme.FONT_BODY};
  --font-mono: ${theme.FONT_MONO};
  color-scheme: dark;
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive);
  --color-destructive-foreground: var(--destructive-foreground);
  --color-destructive-text: var(--destructive-text);
  --color-border: var(--border);
  --color-input: var(--input);
  --color-ring: var(--ring);

  --color-paper: var(--paper);
  --color-paper-foreground: var(--paper-foreground);
  --color-paper-muted: var(--paper-muted);
  --color-paper-border: var(--paper-border);
  --color-paper-raised: var(--paper-raised);
  --color-moss: var(--bara-moss);
  --color-canopy-deep: var(--bara-canopy-deep);

  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);

  --font-display: var(--font-display);
  --font-body: var(--font-body);
  --font-mono: var(--font-mono);
}
`;

const outPath = join(here, "..", "src", "styles", "tokens.css");
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, css, "utf8");
console.log(`[theme] wrote ${outPath}`);
