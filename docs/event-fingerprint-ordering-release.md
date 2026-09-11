# Deterministic event fingerprint ordering

Status: verified locally and code-review approved (SHIP); production deployment pending explicit approval.

When several participants have the same multiplier-event start time, the previous event ordering `(starts_at, event_id)` left tied rows. Planning rejected the cache proof and reread the event vector. This change uses `(starts_at, event_id, entitlement_id, impact_id, user_id)` consistently in authoritative reads, cache fills, and local refreshes. Cached materialization preserves PostgreSQL's order instead of re-sorting text in JavaScript.

The proof no longer performs the obsolete tie-ambiguity aggregation. It still hashes bounded impact/entitlement revision and incarnation evidence; timestamp precision, coverage, size, duplicate full-identity, and final transaction guards remain. No score formula, event eligibility, powerup behavior, or public API changes.

## Compatibility

Event cache namespace changes from v2 to v3 and payload schema from 2 to 3. Input fingerprint schema changes from 4 to 5, so pre-change display artifacts mismatch and fall back to fresh computation. Old/new workers can coexist with separate event cache namespaces and authoritative final fences. Old cache keys expire naturally. No cache flush, migration, dependency change, environment change, runtime flag, or mobile release is required.

## Focused validation

- Added regression tests first: old code failed because tied planning still read events and cache schema remained 2.
- 31 integration tests in `test/integration/event-fingerprint-cache.test.js`: all pass.
- 9 pure fingerprint tests in `test/services/raceResolutionInputFingerprint.test.js`: all pass.
- Two additional team/non-team worker/HTTP cases in `query-efficiency-fingerprint-rows.test.js`: pass, including schema-5 equality and schema-4 rejection.
- Total: 42 passed (33 integration, 9 unit), zero failed/skipped. Initial focused files took approximately seven seconds; the two version cases took approximately twelve seconds.
- Tests ran against a dedicated local database ending `_test` and a dedicated local Redis instance. No production test writes.
- Did not run the huge integration/unit suites, per requested scope. No Flutter changes/builds.

The new tied-user case verifies 50/60 steps produce 100/120 committed points, warm planning uses three SELECTs with zero event-vector reads, a forced local refresh matches the authoritative vector, and changing the multiplier before the final transaction correctly produces 240 for 80 steps. Existing old/current HTTP, Redis errors, time boundaries, corruption, incarnation invalidation, and collation/history cases also pass.

The existing tied-window test previously required cache bypass. Only its query-budget/bypass assertions were updated for the requested behavior; its score, history, inactive-member, and authoritative-parity assertions were retained.

The older typed-roster test also banned JSON aggregation inside the pre-existing event-proof CTE. The same failure was reproduced on the deployed baseline. Its assertion now requires the typed roster SELECT, prohibits roster/user data in the proof prefix, and retains the no-JSON-assembly check on the roster statement. This preserves the original invariant while allowing the existing proof hash.

## Release scope

Prepared in an isolated branch based on deployed revision `83940f9f341f5889e805c59e62693468c41c5dd7`, excluding unrelated local work. Deploy only this reviewed change and required release documentation after approval. Keep exactly two HTTP workers and existing cron/resolution companions; keep staging stopped.

After deployment, confirm process health and compare the event-query family over a comparable traffic window. Expected measured behavior is one fewer planning SELECT for warm tied races (four to three); final database revalidation stays. No total CPU reduction percentage is promised.
