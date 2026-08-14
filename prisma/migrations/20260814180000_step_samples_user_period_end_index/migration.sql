-- Dependency-closure Phase 3: an ORDERED path for the resolution fingerprint's
-- per-member `MIN(period_end) WHERE period_end > $now` correlated subselect
-- (raceResolutionInputFingerprint.js). The existing
-- (user_id, period_start, period_end) index cannot answer that predicate in
-- sorted order, so Postgres scanned every one of a member's sample rows and
-- aggregated: on a 400-member race with 7 days of 5-minute samples that subplan
-- alone was 9,662 buffers / 4,800 heap fetches and dominated the planner's p95
-- tail (405 ms cold, 40 ms warm). With this index the aggregate collapses to an
-- InitPlan Limit-1 ordered index-only scan: 1,603 buffers / 400 heap fetches,
-- 6.3 ms cold. See the Phase 3 report for the EXPLAIN before/after.
--
-- ADDITIVE ONLY and mixed-version safe: an index changes no row, no column, and
-- no query result. Old binaries never see it; the new binary is correct without
-- it (only slower). CONCURRENTLY so the prod build never takes a write lock on
-- step_samples, which is the hottest write table in the system.
CREATE INDEX CONCURRENTLY IF NOT EXISTS
  "step_samples_user_id_period_end_idx"
ON "step_samples"("user_id", "period_end");
