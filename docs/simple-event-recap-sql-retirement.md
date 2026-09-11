# Simple recap: SQL retirement and deployment gates

Implementation artifact, not deployment authorization. Production has not been changed.

## Release A: replacement and stopped-writer cutover

1. Reverify the release descends from the current production commit and audit any newer migrations against the explicit inventory below. Obtain fresh deployment approval, backup evidence, and a compatible replacement recovery artifact. Keep the existing production process layout with exactly two PM2 workers; add no new worker roles or capacity. Staging remains stopped.
2. Inspect production catalog definitions, saved-summary count, retired scratch sizes and detached score owners SELECT-only. More than 10,000 detached owners causes cutover to fail closed: plan a bounded existing-GC drain first. Measure deletion of representative retained scratch before accepting the deployment window; the local 1,000-point fixture is not a bound on production size.
3. Apply additive Prisma migration `20260911120000_simple_event_recap_expand`. It adds saved recaps, nullable event-start count stamps and indexes; the old application still works at this point.
4. Stop intake and drain/stop all old HTTP, cron, resolution and standalone writers using the established deployment procedure. Confirm process termination **and** no remaining application DB sessions/transactions. The cutover script rejects any other client backend; that snapshot does not replace process ownership checks or prevent a mistakenly restarted old process.
5. Run `psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --file=scripts/simple-event-recap-cutover.sql`. Use the approved direct administrative connection, not an application transaction pool. It takes source-table locks and has 5-second lock / 120-second statement timeouts. Any pre-commit failure rolls the transaction back; keep traffic held until a compatible state is established. If the final read-only verifier fails after COMMIT, cutover **has committed**: do not restart the old binary.
6. Cutover copies all saved IDs, numbers, timestamps and acknowledgments in 500-row pages; preserves null legacy expiry; suppresses nonpositive, null-expiry and previously hidden V1 saved results. It detaches eight old triggers, rewrites notification recovery, changes only ten enumerated retired-storage FKs, removes retired recovery hints/job fences in 500-row statements, and records `simple_event_recap:cutover:v1` in existing `job_runs`. Repeated successful cutover preserves the initial stamp and saved values. Old completed scratch without a live request is removed in bounded 500-owner pages (maximum 10,000 owners, otherwise abort).
7. Start only the replacement runtime. Its bumped saved-recap cache namespace makes old cached entries unreachable; no Redis-wide flush. Verify old/new Home, acknowledgment, terminal receipt shim, step sync, real race scoring and notification recovery. Inspect SQL/capture counters: no summary scheduler, capture journaling, old-root GC or recap-driven race work.
8. Record successful deployment time and the final-drop due date in the release audit. The SQL marker proves cutover time; schedule B at least seven days after the **successful replacement deployment**, even if deployment completed later than that marker. Backend owner tracks this task. Client rollout percentage does not control retirement because old endpoints already use the replacement.

## Release B: physical retirement, at least one week later

Fresh authorization and backup/restore rehearsal are mandatory. This script is deliberately **outside `prisma/migrations`** so `prisma migrate deploy` cannot run it in Release A.

1. Verify one week has elapsed since successful Release A, replacement rollback artifact is available, and no current runtime/tools reference retired objects. Repeat current catalog/dependency audit, including SQL-string function bodies not represented fully in `pg_depend`.
2. Stop/drain clients for the small schema-change window. Run `psql "$DATABASE_URL" --set=ON_ERROR_STOP=1 --file=scripts/simple-event-recap-final-drop.sql`.
3. It rejects an absent/younger-than-seven-days cutover marker, remaining clients/triggers/candidates, unknown capture function signatures, or saved rows not preserved in the replacement. It drops the exact functions/tables/columns below without `CASCADE`, records completion in `job_runs`, and runs the read-only verifier.
4. Resume the replacement and repeat old/new HTTP/scoring/retention checks. Verify zero retired tables/functions/columns. Applied migration history remains unchanged. An application-only rollback to the old engine is invalid before or after B; database restoration is coordinated recovery, never an improvised code revert.

Migrated `LEGACY_SAVED` results survive ordinary entitlement retention so B can
compare all source evidence. After that comparison and source removal, B deletes
only migrated results lacking an entitlement and with a known expiry already
past, in 500-row pages. Missing entitlement is important: entitlement retention
uses event end, while recap expiry is next midnight (up to one day later).
Requiring another 30 days from expiry could strand just-retired copies forever.
Null/future expiry remains retained. Once the durable final-drop completion
marker exists, normal entitlement retention also removes its migrated recap;
copies that age out after B therefore do not become permanent orphans. This
cleanup is rerun-safe; account deletion still removes all of that user's data.

## Exact retirement inventory

The scripts are executable allowlists. Newly discovered signatures/dependencies require an explicit audit, not a broader wildcard drop.

Detached triggers (relation → trigger):

- `steps` → `durable_capture_steps_source`.
- `step_samples` → `durable_capture_samples_source`.
- `global_event_race_impacts` → `global_event_summary_impact_vector_fence`, `global_event_recovery_impact_changed`.
- `durable_global_event_capture_requests` → `durable_capture_deleted_owner`, `durable_capture_terminal_pin_release`.
- `global_event_summary_work` → `global_event_recovery_work_changed`.
- `job_runs` → `global_event_recovery_job_changed`.

Retired tables (21): `global_event_summary_work`, `global_event_capture_artifacts`, `global_event_user_summaries`, `durable_global_event_capture_requests`; and the `durable_capture_` tables `fact_heads`, `fact_journal`, `fact_roots`, `fact_pins`, `fact_identities`, `fact_pages`, `prepared_inputs`, `method_progress`, `interval_projections`, `score_progress`, `score_plans`, `score_points`, `score_transfers`, `score_owners`, `pin_releases`, `compaction_schedule`, `root_sweep`.

Retired function signatures: `fence_global_event_summary_impact_vector()`, `durable_capture_fact_days(text,jsonb)`, `durable_capture_journal_source()`, `durable_capture_append_fact_page(uuid,jsonb)`, `durable_capture_materialize_root(uuid)`, `durable_capture_prepare_root(uuid)` (already absent in observed latest schema), `durable_capture_compact(integer)`, `durable_capture_pin_roots(uuid,jsonb)`, `durable_capture_release_deleted_owner()`, `queue_durable_capture_pin_release()`, `durable_capture_evict_roots(integer)`, `durable_capture_evict_roots_internal(integer,boolean)`, `durable_capture_compact_internal(integer,boolean)`, `durable_capture_compact_if_due(integer)`.

Shared recovery: replace `global_event_recovery_refresh`, `source_changed`, `parent_changed`, `completion_changed`, `revalidate_page`, `seed_page` with ENTITLEMENT_EVENT-only logic. Preserve parent-deletion/orphan-cleanup functions, entitlement/outbox/receipt/user/event triggers, and shared candidate/seed/event-refresh/orphan-cursor tables. Remove impact seed row at A; obsolete impact cursor columns and SUMMARY candidate-kind alternatives at B. No impact-history scan remains in these functions.

Membership retained: `global_event_race_impacts` keeps id, event/race/user IDs, created/updated timestamps, uniqueness and live FKs. B drops only status, delta, attribution/capture/source-generation/terminal/settled columns and dependent recap indexes. `global_step_events.summary_attribution_version` also goes; actual multiplier/window/notification metadata remains.

## Retained-storage deletion exception

“Inert” means no application reads/writes, worker, polling or journaling. **Passive integrity cascades on parent deletion are the sole exception** during the one-week interval, necessary to preserve account deletion and personal-data cleanup.

Five old live-parent RESTRICT FKs become CASCADE: old saved-summary event/user, old summary-work event, old capture-artifact event/race. Five internal scratch FKs also become CASCADE: score owner → live request (formerly SET NULL), score progress/plans/transfers → owner, score points → composite plan. All constraint names, columns, parent targets, ON UPDATE behavior and validation are preserved. No live membership/scoring FK changes.

The internal changes are necessary because retiring GC would otherwise leave detached score payloads. Existing detached owners are already eligible for old GC and are cleaned during cutover. Linked owners subsequently disappear with their requests and scratch descendants; unrelated owners remain. Account deletion must be verified through real HTTP with populated retained descendants before production readiness.

## Local evidence

`scripts/simple-event-recap-sql-rehearsal.cjs` refuses anything except a loopback `bara_recap_sql_test` database and NODE_ENV=test. Its input is a synthetic populated baseline clone, never a production dump. It tests the missing-retirement failure, active-client refusal, exact saved-copy preservation and suppression, cutover retry, both raw-table INSERT/UPDATE/DELETE paths with unchanged capture counts, notification seed/revalidation, 1,000-point descendant deletion without touching another owner, actual replacement retention between releases, early-drop refusal, final removal preserving unrelated saved recaps and shared recovery, and final-drop retry. Separate HTTP integration tests cover customer-facing paths.

`scripts/simple-event-recap-compare.cjs <repository> <baseline|candidate> <output.json>`
replays six users across three shared races through real HTTP and production
worker paths. It requires disposable loopback PostgreSQL on port 55441, exact
`bara_recap_baseline_test` / `bara_recap_candidate_test` names, dedicated Redis
`redis://127.0.0.1:16437/0`, and `NODE_ENV=test`. The output directory must contain
the owned PostgreSQL cluster's `pgdata/postmaster.pid` for CPU sampling. Prepare
baseline schema from the baseline checkout and candidate schema with A/cutover;
never use production data. It clears its dedicated fixtures and Redis state.
Run each variant sequentially at least three times without concurrent workloads
on that cluster. Compare command counts and identical scoring/recap outcomes;
report CPU/WAL sampling limits and do not treat table-stat deltas as exact writes.
