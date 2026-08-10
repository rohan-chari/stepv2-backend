// Prerenders each page's markup into its built HTML at BUILD time.
//
// WHY this exists: without it, dist/privacy.html is `<div id="app"></div>` plus
// a module script, so the page is BLANK whenever that script doesn't run —
// JS disabled, a blocked/failed CDN fetch, or edge-cached HTML pointing at a
// bundle hash a later build removed. /privacy is the URL on the App Store
// listing and /support is where users go when something is already broken;
// neither may depend on JavaScript to show its text. The old static
// public/*.html could not fail this way and the replacement must not either.
//
// This is NOT runtime SSR — the Express process still only serves static files
// (the spec's non-goal). Vue renders to a string here, on this machine, once,
// and the result is baked into the committed dist/. The client then hydrates
// that same markup (see src/*.js, which use createSSRApp for exactly this).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { renderToString } from "vue/server-renderer";
import { createSSRApp } from "vue";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const distDir = join(webRoot, "dist");

const PAGES = [
  { html: "index.html", component: "/src/pages/HomePage.vue" },
  { html: "privacy.html", component: "/src/pages/PrivacyPage.vue" },
  { html: "support.html", component: "/src/pages/SupportPage.vue" },
];

// Vite's SSR module loader resolves asset imports to their SOURCE urls
// (/src/assets/coin.png), which don't exist in the built output. The client
// build's manifest maps each source path to its emitted hashed file, so the
// prerendered markup gets rewritten to the same URLs the hydrating client will
// request — otherwise every <img> would 404 for exactly the no-JS visitors this
// script exists to serve.
function buildAssetUrlMap() {
  const manifest = JSON.parse(
    readFileSync(join(distDir, ".vite", "manifest.json"), "utf8")
  );
  const map = new Map();
  for (const [src, entry] of Object.entries(manifest)) {
    if (entry.file && /\.(png|jpe?g|gif|svg|webp|avif)$/i.test(src)) {
      map.set(`/${src}`, `/${entry.file}`);
    }
  }
  return map;
}

const vite = await createServer({
  root: webRoot,
  logLevel: "warn",
  server: { middlewareMode: true },
  appType: "custom",
  // Dependency pre-bundling exists to speed up a long-lived dev server. This
  // server renders three components and exits, so the scan is pure cost — and
  // because it runs asynchronously, it is still crawling when vite.close() lands
  // and dumps a wall of "server is being restarted or closed" esbuild errors
  // into a build that actually succeeded.
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const assetUrls = buildAssetUrlMap();

  for (const page of PAGES) {
    const mod = await vite.ssrLoadModule(page.component);
    let markup = await renderToString(createSSRApp(mod.default));

    for (const [sourceUrl, builtUrl] of assetUrls) {
      markup = markup.split(sourceUrl).join(builtUrl);
    }

    if (/\/src\/assets\//.test(markup)) {
      throw new Error(
        `${page.html}: an asset URL was not rewritten to its built path — the ` +
          `prerendered page would ship a 404ing image.`
      );
    }

    const htmlPath = join(distDir, page.html);
    const html = readFileSync(htmlPath, "utf8");
    const placeholder = '<div id="app"></div>';
    if (!html.includes(placeholder)) {
      throw new Error(`${page.html}: mount point ${placeholder} not found.`);
    }
    writeFileSync(
      htmlPath,
      html.replace(placeholder, `<div id="app">${markup}</div>`),
      "utf8"
    );
    console.log(`[prerender] ${page.html} — ${markup.length} bytes of markup`);
  }
} finally {
  await vite.close();
}
