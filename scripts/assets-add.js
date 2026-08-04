#!/usr/bin/env node
//
// npm run assets:add -- <src.png> <accessories|characters|powerups> <key>
//
// Installs a PNG into this repo's CDN-served asset tree:
//
//   public/assets/<category>/<key>@<sha256-12>.png
//
// The 12-hex sha256 prefix of the FILE BYTES is the asset version, and it is
// part of the filename, which is what makes the URL immutable and safe to cache
// for a year at the Cloudflare edge and on device. New art => new bytes => new
// hash => new URL; nothing is ever invalidated.
//
// `<key>` is the shop item's `assetKey` for accessories/characters, and the
// LOWERCASED PowerupType for powerups (e.g. `trail_mine`).
//
// ORDER OF OPERATIONS MATTERS — the script prints it too:
//   1. run this script          (adds the file to the working tree)
//   2. commit + deploy the backend  (the PNG must be reachable FIRST)
//   3. THEN create/patch the DB row with the printed assetVersion
// Doing 3 before 2 lets a client request a URL that 404s, and Cloudflare will
// happily cache that 404 at the edge.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CATEGORIES = new Set(["accessories", "characters", "powerups"]);
const KEY_PATTERN = /^[a-z0-9][a-z0-9_]*$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ASSETS_ROOT = path.join(__dirname, "..", "public", "assets");

function fail(message) {
  console.error(`assets:add — ${message}`);
  process.exit(1);
}

function usage() {
  console.error(
    "usage: npm run assets:add -- <src.png> <accessories|characters|powerups> <key>"
  );
}

function main(argv) {
  const [srcArg, category, key] = argv;
  if (!srcArg || !category || !key) {
    usage();
    process.exit(1);
  }
  if (!CATEGORIES.has(category)) {
    fail(`category must be one of ${[...CATEGORIES].join(", ")} (got "${category}")`);
  }
  if (!KEY_PATTERN.test(key)) {
    fail(
      `key must be lowercase letters/digits/underscores (got "${key}"). ` +
        "For powerups use the lowercased PowerupType, e.g. trail_mine."
    );
  }

  const src = path.resolve(srcArg);
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    fail(`source file not found: ${src}`);
  }
  const bytes = fs.readFileSync(src);
  if (!bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    fail(`${src} is not a PNG (bad magic number)`);
  }

  const version = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12);
  const dir = path.join(ASSETS_ROOT, category);
  const filename = `${key}@${version}.png`;
  const dest = path.join(dir, filename);

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest);
    if (!existing.equals(bytes)) {
      // Practically impossible (that's a sha256 collision on a 12-hex prefix)
      // but the whole cache model rests on "this URL's bytes never change", so
      // refuse rather than silently break every device that already cached it.
      fail(
        `${dest} already exists with DIFFERENT bytes. Refusing to overwrite — ` +
          "a published asset URL must be immutable."
      );
    }
    console.log(`Already installed (identical bytes): public/assets/${category}/${filename}`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dest, bytes);
    console.log(`Wrote public/assets/${category}/${filename} (${bytes.length} bytes)`);
  }

  // Stale siblings: the same key at an older version. Harmless to keep (nothing
  // points at them once the DB row moves) but worth surfacing so the repo does
  // not accumulate dead art forever.
  const stale = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${key}@`) && f !== filename);
  if (stale.length) {
    console.log(
      `\nOlder versions of "${key}" still in the tree (safe to delete once no ` +
        `DB row references them):\n  ${stale.join("\n  ")}`
    );
  }

  const base = (process.env.ASSET_BASE_URL || "https://steptracker-api.org").replace(
    /\/+$/,
    ""
  );
  const url = `${base}/assets/${category}/${filename}`;

  console.log(`\nassetVersion: ${version}`);
  console.log(`URL:          ${url}`);

  console.log("\nNEXT STEPS — in this order:");
  console.log("  1. git add public/assets && commit");
  console.log("  2. DEPLOY the backend so the PNG is live (verify with:");
  console.log(`       curl -sI ${url} )`);
  console.log("  3. ONLY THEN create/patch the DB row below.");
  console.log(
    "     Creating the row first lets clients request a URL that 404s — and " +
      "Cloudflare caches 404s."
  );

  if (category === "powerups") {
    console.log("\n  PATCH /admin/powerup-shop/items/<id>");
    console.log(JSON.stringify({ assetVersion: version }, null, 2));
  } else {
    const body = {
      sku: key,
      name: "TODO",
      description: "TODO",
      slot: category === "characters" ? "CHARACTER" : "HEAD",
      priceCoins: 75,
      assetKey: key,
      assetVersion: version,
      bobble: category === "characters" ? false : true,
      sortOrder: 0,
      // testOnly defaults to TRUE server-side — keep it that way until the
      // CDN-capable App Store build has rolled out.
      renderMetadata:
        category === "characters"
          ? { animationFrames: 6, baselineOffset: -0.09 }
          : { offsetX: 0, offsetY: 0, rotation: 0, scale: 1 },
    };
    console.log("\n  POST /admin/shop/items");
    console.log(JSON.stringify(body, null, 2));
    if (category === "characters") {
      console.log(
        "\n  NOTE: a remote character has NO bundled _thumb.png safety net — " +
          "renderMetadata.animationFrames MUST be correct or the walk cycle " +
          "renders as a smeared sheet. The manifest re-serves it, so a tuner " +
          "save that wipes it breaks every client at once."
      );
    }
    console.log(
      "\n  Then fine-tune placement in Admin → Accessory Tuner (saves mirror " +
        "prod ↔ staging automatically)."
    );
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { main };
