// Shared offset/limit math for the two participant pagers.
//
// This is a VERBATIM extraction of the arithmetic that shipped inline in
// getRaceProgress.js (the `participants-v1` progress pager). It is reproduced
// here — not "improved" — because getRaceProgress's own contract tests pin its
// exact outputs, and because the race-details pager must page identically or a
// client walking both arrays would see two different conventions.
//
// Deliberately NOT domain-aware: it lives in src/shared/ (no races import) and
// knows nothing about race status, team races, or whether a given response
// SHOULD be pageable at all. That "pageable shape" decision stays local to each
// query, where the domain reasons for it are written down.
//
// Semantics worth pinning, all inherited from the original inline code:
//   * A non-numeric / negative / zero offset is 0 (`Number(x) > 0` is false for
//     NaN, so garbage clamps down rather than throwing).
//   * A non-finite limit (missing, "abc", Infinity) falls back to defaultLimit;
//     anything finite is floored and clamped into [1, maxLimit].
//   * `start` is clamped to `total`, so an offset past the end yields an empty
//     page instead of a negative slice.
//   * `nextOffset` is ALWAYS `start + safeLimit`, even when that runs past the
//     end (offset=470, limit=10, total=477 => nextOffset 480, hasMore false).
//     A paging client stops on `hasMore`, never by comparing nextOffset.
function clampOffsetLimit({
  offset = 0,
  limit,
  total = 0,
  defaultLimit = 10,
  maxLimit = 50,
} = {}) {
  const parsedTotal = Number(total);
  const safeTotal =
    Number.isFinite(parsedTotal) && parsedTotal > 0 ? Math.floor(parsedTotal) : 0;

  const parsedOffset = Number(offset);
  const safeOffset = parsedOffset > 0 ? Math.floor(parsedOffset) : 0;

  const parsedLimit = Number(limit);
  const safeLimit = Math.min(
    Math.max(
      Number.isFinite(parsedLimit) ? Math.floor(parsedLimit) : defaultLimit,
      1
    ),
    maxLimit
  );

  const start = Math.min(safeOffset, safeTotal);
  return {
    start,
    safeLimit,
    hasMore: start + safeLimit < safeTotal,
    nextOffset: start + safeLimit,
  };
}

module.exports = { clampOffsetLimit };
