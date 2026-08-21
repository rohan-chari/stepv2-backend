const crypto = require("node:crypto");

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function snapshotManifestHash(manifest) { return sha256(stable(manifest)); }
function attestationSignature(attestation, secret) { return crypto.createHmac("sha256", secret).update(stable({ ...attestation, signature: undefined })).digest("hex"); }

function createScrubAttestation({ snapshotHash, scrubScriptHash, baseline, expiresAt, verifiedAt = new Date().toISOString() }, secret) {
  if (!/^[a-f0-9]{64}$/.test(snapshotHash) || !/^[a-f0-9]{64}$/.test(scrubScriptHash)) throw new Error("scrub attestation hashes must be SHA-256 values");
  if (!secret || String(secret).length < 32) throw new Error("scrub attestation secret must be at least 32 characters");
  const attestation = { schema: "capacity-scrub-attestation-v1", snapshotHash, scrubScriptHash, verifiedAt, expiresAt, verification: "passed", baseline };
  return { ...attestation, signature: attestationSignature(attestation, secret) };
}

function assertSnapshotAttestation({ manifest, attestation, secret, now = new Date() }) {
  if (!manifest || !attestation || attestation.schema !== "capacity-scrub-attestation-v1") throw new Error("scrub attestation is missing or has an unsupported schema");
  const snapshotHash = manifest.snapshotHash || snapshotManifestHash(manifest.approvedManifest || manifest.manifest || manifest);
  if (attestation.snapshotHash !== snapshotHash) throw new Error("scrub attestation snapshot does not match approved snapshot");
  if (attestation.verification !== "passed") throw new Error("scrub verification did not pass");
  const expiry = new Date(attestation.expiresAt);
  if (!Number.isFinite(expiry.getTime()) || expiry <= now) throw new Error("scrub attestation is missing or expired");
  if (!secret || String(secret).length < 32 || attestation.signature !== attestationSignature(attestation, secret)) throw new Error("scrub attestation signature is invalid");
  return { snapshotHash, attestationHash: sha256(stable(attestation)), expiresAt: attestation.expiresAt, baseline: attestation.baseline };
}

function compareLiveManifest(approved, live) {
  const differences = [];
  function walk(left, right, path = "manifest") {
    if (stable(left) === stable(right)) return;
    if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]).values()) walk(left[key], right[key], `${path}.${key}`);
      return;
    }
    differences.push({ path, approved: left ?? null, live: right ?? null });
  }
  walk(approved, live);
  return { ok: differences.length === 0, differences };
}

function manifestLines(manifest) {
  return [
    "APPROVED CAPACITY START MANIFEST (must match live environment)",
    JSON.stringify(manifest, null, 2),
    "Type exactly: START <run-id> <snapshot-sha256>",
  ];
}

function confirmCapacityStart({ runId, snapshotHash, manifest, input, interactive }) {
  if (!interactive) throw new Error("capacity start requires fresh interactive confirmation; there is no --yes bypass");
  if (typeof input !== "string" || input.trim() !== `START ${runId} ${snapshotHash}`) throw new Error("capacity start confirmation did not match run and snapshot identity");
  if (!manifest || !manifest.vps || !manifest.database || !manifest.redis || !manifest.queue || !manifest.network) throw new Error("complete VPS and database capacity manifest is required");
  return { confirmed: true, manifestLines: manifestLines(manifest) };
}

module.exports = { assertSnapshotAttestation, attestationSignature, compareLiveManifest, confirmCapacityStart, createScrubAttestation, manifestLines, snapshotManifestHash, stable };
