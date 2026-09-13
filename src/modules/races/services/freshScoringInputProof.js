// Ephemeral provenance only: serialization, display artifacts, and copies cannot
// turn an older fingerprint into a fresh initial proof read.
const reads = new WeakMap();
function bindFreshScoringInputProof(fingerprint, rows) {
  if (fingerprint && Array.isArray(rows) && rows.every(row =>
    Object.hasOwn(row, 'historicalRawRevision') && Object.hasOwn(row, 'historicalRawCompleteGeneration') &&
    Object.hasOwn(row, 'historicalRawProtectedCutoff'))) {
    reads.set(fingerprint, new Map(rows.map(row => [row.userId, Object.freeze({
      userId: row.userId, generation: row.generation,
      historicalRawRevision: row.historicalRawRevision,
      historicalRawCompleteGeneration: row.historicalRawCompleteGeneration,
      historicalRawProtectedCutoff: row.historicalRawProtectedCutoff == null ? null : new Date(row.historicalRawProtectedCutoff).toISOString(),
    })])));
  }
  return fingerprint;
}
function takeFreshScoringInputProof(fingerprint) {
  const value = reads.get(fingerprint);
  reads.delete(fingerprint);
  return value;
}
module.exports = { bindFreshScoringInputProof, takeFreshScoringInputProof };
