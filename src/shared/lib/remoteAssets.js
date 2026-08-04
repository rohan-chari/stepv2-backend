// CDN-served art ("remote assets") — the one place that knows how an
// `assetVersion` becomes a URL.
//
// Art for an item is EITHER bundled in the app binary (assetVersion NULL — the
// historical path, unchanged for every existing item and every frozen client)
// OR served from this API's own /assets tree, in which case the row carries a
// 12-hex sha256 prefix of the PNG bytes. That version is baked into the
// FILENAME, so the URL is immutable: it can be cached forever on the CDN edge
// and on device, and re-uploading art simply produces a new filename.
//
//   /assets/accessories/<assetKey>@<assetVersion>.png   (non-CHARACTER slots)
//   /assets/characters/<assetKey>@<assetVersion>.png    (CHARACTER slot)
//   /assets/powerups/<powerup_type lowercased>@<assetVersion>.png

// The hex digest prefix we accept from the admin API. 8-64 hex chars covers a
// 12-hex prefix (what scripts/assets-add.js emits) up to a full sha256.
const ASSET_VERSION_PATTERN = /^[a-f0-9]{8,64}$/i;

const DEFAULT_ASSET_BASE_URL = "https://steptracker-api.org";

// Read at call time (not module load) so an env change — or a test — is picked
// up without re-requiring. Trailing slashes are trimmed so URL joins are exact.
function assetBaseUrl() {
  const raw = process.env.ASSET_BASE_URL;
  const base =
    typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_ASSET_BASE_URL;
  return base.replace(/\/+$/, "");
}

function isValidAssetVersion(value) {
  return typeof value === "string" && ASSET_VERSION_PATTERN.test(value);
}

// null in ⇒ null out. Anything that isn't a well-formed version also yields
// null rather than a broken URL: a serializer must never hand a client a link
// that 404s (Cloudflare would happily cache the 404).
function buildAssetUrl(category, key, version) {
  if (!isValidAssetVersion(version)) return null;
  if (typeof key !== "string" || key.trim() === "") return null;
  return `${assetBaseUrl()}/assets/${category}/${key}@${version}.png`;
}

// CHARACTER items are walk-cycle sprite sheets, not accessories; they live in
// their own directory so the two never collide on assetKey.
function categoryForSlot(slot) {
  return slot === "CHARACTER" ? "characters" : "accessories";
}

function shopItemAssetUrl(item) {
  if (!item) return null;
  return buildAssetUrl(categoryForSlot(item.slot), item.assetKey, item.assetVersion);
}

// Powerup icons are keyed by the enum value, lowercased, so the filename is
// derivable without a per-item assetKey column.
function powerupAssetUrl(powerupType, assetVersion) {
  if (typeof powerupType !== "string" || powerupType === "") return null;
  return buildAssetUrl("powerups", powerupType.toLowerCase(), assetVersion);
}

module.exports = {
  ASSET_VERSION_PATTERN,
  DEFAULT_ASSET_BASE_URL,
  assetBaseUrl,
  isValidAssetVersion,
  buildAssetUrl,
  categoryForSlot,
  shopItemAssetUrl,
  powerupAssetUrl,
};
