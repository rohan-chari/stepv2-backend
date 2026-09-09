// SELECT-only, bounded catalog/reference audit. It can inspect release A or a
// pre-A database; absent additive tables are reported rather than assumed empty.
process.env.DOTENV_CONFIG_QUIET = "true";
require("dotenv").config({ quiet: true });
const { Client } = require("pg");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const retirement = require("../data/character-wardrobe-retirements.json");
const LEGEND_COSMETIC_SKU = "ranked_legend_crown";
const REFERENCES = [
  ["user_shop_items", "shop_item_id", "owners"],
  ["user_equipped_accessories", "shop_item_id", "equipped"],
  ["character_wardrobe_items", "shop_item_id", "saved"],
  ["shop_purchase_requests", "shop_item_id", "purchases"],
  ["ad_reward_grants", "shop_item_id", "ads"],
  ["daily_reward_claims", "shop_item_id", "dailyRewards"],
  ["billing_cosmetic_releases", "shop_item_id", "billingReleases"],
  ["billing_cosmetic_grants", "shop_item_id", "billingGrants"],
];
function fingerprint(row) {
  return crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
}
async function audit(
  db,
  { after = null, limit = 200, frontendRoot = null } = {},
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error("limit must be 1–200");
  await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await db.query("SET LOCAL statement_timeout='15s'");
    const rows = (
      await db.query(
        "SELECT * FROM shop_items WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2",
        [after, limit],
      )
    ).rows;
    const ids = rows.map((i) => i.id),
      counts = new Map(ids.map((id) => [id, {}]));
    // SSV shop-unlock grants deliberately bind by SKU; old grants may bind by
    // ID. Preserve either identity, including ambiguous cross-namespace values.
    const referenceKeys = [...new Set(rows.flatMap((i) => [i.id, i.sku]))];
    const missingTables = [];
    for (const [table, column, label] of REFERENCES) {
      const exists = (
        await db.query("SELECT to_regclass($1) AS relation", [table])
      ).rows[0].relation;
      if (!exists) {
        missingTables.push(table);
        continue;
      }
      const refs = (
        await db.query(
          `SELECT ${column} AS id,count(*)::int AS count FROM ${table} WHERE ${column}=ANY($1::text[]) GROUP BY ${column}`,
          [referenceKeys],
        )
      ).rows;
      for (const r of refs)
        for (const item of rows.filter(
          (i) => i.id === r.id || i.sku === r.id,
        )) {
          const counter = counts.get(item.id);
          counter[label] = (counter[label] || 0) + r.count;
        }
    }
    // Purchase replay JSON may contain equipment other than the purchased item.
    // Page the source rows, visiting each request once for this bounded item page.
    let requestCursor = null;
    let requestsChecked = 0;
    for (;;) {
      const requests = (
        await db.query(
          "SELECT id,result_json FROM shop_purchase_requests WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 200",
          [requestCursor],
        )
      ).rows;
      if (!requests.length) break;
      for (const r of requests) {
        const json = JSON.stringify(r.result_json);
        for (const item of rows)
          if (
            json.includes(JSON.stringify(item.id)) ||
            json.includes(JSON.stringify(item.sku))
          )
            counts.get(item.id).replay = (counts.get(item.id).replay || 0) + 1;
      }
      requestsChecked += requests.length;
      requestCursor = requests.at(-1).id;
    }
    let userCursor = null,
      usersChecked = 0,
      activeMismatches = 0;
    if (!missingTables.includes("character_wardrobe_items"))
      for (;;) {
        const users = (
          await db.query(
            `SELECT u.id, EXISTS(SELECT 1 FROM character_wardrobes w WHERE w.user_id=u.id AND w.character_key=COALESCE((SELECT shop_item_id FROM user_equipped_accessories e WHERE e.user_id=u.id AND slot='CHARACTER'),'default') AND COALESCE((SELECT jsonb_object_agg(slot,shop_item_id) FROM character_wardrobe_items wi WHERE wi.wardrobe_id=w.id),'{}')<>COALESCE((SELECT jsonb_object_agg(slot,shop_item_id) FROM user_equipped_accessories e WHERE e.user_id=u.id AND slot<>'CHARACTER'),'{}')) AS mismatch FROM users u WHERE ($1::text IS NULL OR u.id>$1) ORDER BY u.id LIMIT 200`,
            [userCursor],
          )
        ).rows;
        if (!users.length) break;
        usersChecked += users.length;
        activeMismatches += users.filter((u) => u.mismatch).length;
        userCursor = users.at(-1).id;
      }
    const fitManifestPath = path.join(
      __dirname,
      "../data/character-wardrobe-fits.json",
    );
    const fits = fs.existsSync(fitManifestPath)
      ? JSON.parse(fs.readFileSync(fitManifestPath))
      : null;
    const items = rows.map((i) => {
      const refs = counts.get(i.id),
        rewardPoolEligible =
          i.active && !i.test_only && !i.earn_only && i.slot !== "CHARACTER";
      const manifest = retirement.items.find(
        (x) => x.id === i.id && x.sku === i.sku,
      );
      const bundled = frontendRoot
        ? fs.existsSync(
            path.join(
              frontendRoot,
              "assets/images",
              i.slot === "CHARACTER" ? "characters" : "accessories",
              `${i.asset_key}.png`,
            ),
          )
        : null;
      const referenced =
        Object.values(refs).some((n) => n > 0) || i.sku === LEGEND_COSMETIC_SKU;
      const released = !i.test_only || rewardPoolEligible;
      const classification =
        i.slot === "CHARACTER" || released
          ? "Preserve released"
          : referenced
            ? "Preserve owned-or-referenced"
            : manifest?.historicallyUnreleased === true && !missingTables.length
              ? "Candidate unreleased-unused"
              : "Needs investigation";
      const fit = fits?.items.find((x) => x.id === i.id && x.sku === i.sku);
      return {
        id: i.id,
        sku: i.sku,
        slot: i.slot,
        active: i.active,
        testOnly: i.test_only,
        earnOnly: i.earn_only,
        remoteOnly: i.remote_only,
        assetKey: i.asset_key,
        assetVersion: i.asset_version,
        renderMetadata: i.render_metadata,
        refs,
        rewardPoolEligible,
        rankedReference: i.sku === LEGEND_COSMETIC_SKU,
        bundledAsset: bundled,
        remoteAssetReferenced: !!i.asset_version,
        fitClassification: fit?.classification || null,
        approvedCharacterKeys: fit?.approvedCharacterKeys || [],
        classification,
        expectedFingerprint: fingerprint(i),
      };
    });
    await db.query("COMMIT");
    return {
      contract: "wardrobe-content-audit-v1",
      readAt: new Date().toISOString(),
      source: "SELECT-only REPEATABLE READ",
      missingTables,
      requestsChecked,
      usersChecked,
      activeMismatches,
      items,
      nextCheckpoint: rows.length === limit ? rows.at(-1).id : null,
      unverified: [
        "Historical release status requires reviewed evidence for every retirement candidate.",
        "Bundled presence does not prove visual fit; manually verify the approved mapping in both clients.",
        "No source asset is deleted by this report.",
      ],
    };
  } catch (e) {
    await db.query("ROLLBACK");
    throw e;
  }
}
async function main() {
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    console.log(
      JSON.stringify(
        await audit(db, {
          after:
            process.argv.find((x) => x.startsWith("--after="))?.slice(8) ||
            null,
          frontendRoot:
            process.argv
              .find((x) => x.startsWith("--frontend-root="))
              ?.slice(16) || null,
        }),
        null,
        2,
      ),
    );
  } finally {
    await db.end();
  }
}
if (require.main === module)
  main()
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    })
    .finally(() => process.exit(process.exitCode || 0));
module.exports = { audit, fingerprint };
