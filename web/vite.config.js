import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

// Multi-page build, NOT a single-page app with a router.
//
// The three marketing pages are independent documents served by three explicit
// express `sendFile` routes (src/app.js). Building them as real separate HTML
// entries means the server needs no history-mode fallback and each page ships
// only its own JS.
//
// Working without JavaScript is NOT a property of this config — it comes from
// scripts/prerender.mjs, which bakes each page's rendered markup into the built
// HTML after this build runs. That matters most for /privacy (the URL on the App
// Store listing) and /support (reached when something is already broken).
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    // Consumed by scripts/prerender.mjs to rewrite the SSR pass's source asset
    // URLs (/src/assets/x.png) to their emitted hashed paths.
    manifest: true,
    // Emit EVERY asset as a real file. Vite's default inlines anything under
    // 4KB as a data URI, which leaves it out of the manifest — and the
    // prerender pass has no way to rewrite a URL it can't look up (this bit the
    // 2.4KB capybara sprite). Making emission total keeps the manifest a
    // complete map, at the cost of one extra cached request.
    assetsInlineLimit: 0,
    // MUST stay "web-assets". The backend mounts the game-art CDN at /assets
    // with fallthrough:false, so anything emitted under /assets hard-404s and
    // the site renders unstyled with no JS. src/app.js serves this directory at
    // the matching /web-assets path; scripts/check-build-output.mjs fails the
    // build if this ever drifts.
    assetsDir: "web-assets",
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./index.html", import.meta.url)),
        privacy: fileURLToPath(new URL("./privacy.html", import.meta.url)),
        support: fileURLToPath(new URL("./support.html", import.meta.url)),
      },
    },
  },
});
