// Snapshots the current 5-star App Store reviews into web/src/data/reviews.json
// so the review strip is populated in the PRERENDERED html — i.e. with
// JavaScript disabled, and on the first paint before /reviews/ios has answered.
// The client swaps in the live list on mount.
//
// Run by `npm run build` only — deliberately NOT by `npm run dev`, which would
// make starting a dev server hit the network and rewrite a committed file,
// leaving spurious diffs on whatever branch you happened to be on.
//
// Reuses the very same filter the runtime endpoint uses, so the baked-in
// snapshot and the live feed can never apply different rules about what counts
// as showable.
//
// The written file IS committed: builds must work offline and on a machine that
// cannot reach Apple, and the documented rollback procedure has no build step.
//
// A failed fetch is NOT fatal and must never blank the file — the existing
// snapshot is left exactly as it is and the build continues.

import { createRequire } from "node:module";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const { getFiveStarReviews } = require(
  join(here, "..", "..", "src", "modules", "web", "reviews", "appStoreReviews.js")
);

const outPath = join(here, "..", "src", "data", "reviews.json");

const { reviews } = await getFiveStarReviews();

if (!reviews.length) {
  if (existsSync(outPath)) {
    console.warn("[reviews] fetch returned nothing — keeping the existing snapshot");
    process.exit(0);
  }
  console.warn("[reviews] fetch returned nothing and there is no snapshot — writing []");
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(reviews, null, 2)}\n`, "utf8");
console.log(`[reviews] wrote ${reviews.length} reviews to ${outPath}`);
