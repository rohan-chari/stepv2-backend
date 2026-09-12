# Retire the historical notification snapshot repair scan

The notification completeness reconciler used to search schedule-linked global-event outboxes every five minutes for missing device-attempt records and reset matching RETRY, LEASED, DELIVERED and EXHAUSTED outboxes to RETRY. This repeatedly searched retained history even when nothing needed repair, could reopen terminal deliveries, and could reset a live legacy lease before its owner created the target snapshot.

The approved change removes that single scan. Normal delivery claims still create device snapshots (including NO_DEVICE), recover expired leases, and retry provider failures. Other completeness stages remain unchanged. `missingSnapshotsRearmed` remains present with value `0`; it no longer contributes to notification wakeups or the `fullPage` immediate-rerun decision. No replacement scan, flag, migration, dependency or app change is added.

The intentional behavior change is that malformed terminal outboxes with no attempts are no longer automatically reopened by this stage. They require explicit diagnosis and repair if they occur. The production research found zero such exceptions across 21,908 schedules and 16,387 linked global-event outboxes. See [research and source-path audit](notification-snapshot-repair-research-2026-09-12.md).

## Measured work removed

The ten-minute observation recorded two executions, zero rows repaired, 383,846 cached buffer accesses, 12,934 block reads and 8.85 seconds execution elapsed. The implementation removes one database command per reconciler invocation, including any immediate full-page iterations. It also removes this stage's potential updates and wakeups when it finds candidates. These historical elapsed-time measurements are not a promise of equivalent production CPU savings; no post-deploy benchmark has been performed.

## Validation

Test-first: the five new database-backed tests ran before source modification. Three normal-recovery cases passed; two retirement cases failed because the old scan returned `missingSnapshotsRearmed=1` and changed records the new contract preserves. After implementation all 70 tests across these four suites passed:

- `notification-snapshot-retirement.test.js`: five new cases, preserving terminal outboxes, live leases, normal/admitted abandoned-claim recovery, and a transient push retry after HTTP device registration. Client-visible Inbox responses are checked through real HTTP using the existing `inbox_v1` contract. Cron has no HTTP invocation endpoint, so tests exercise the public job entrypoints against the real database; provider services are replaced with deterministic test adapters.
- `centralized-notification-delivery.test.js`.
- `event-surge-notification-admission.test.js`.
- `global-event-reliability.test.js`.

The existing global-event reliability expectation for `missingSnapshotsRearmed` changes from 1 to 0 as part of the explicitly approved retirement. Its overdue-outbox, terminal-device-target, and removed-materialization assertions remain intact. No assertions were skipped or weakened to hide a failure.

Tests used a freshly created local `bara_notification_retirement_20260912_test` database; its name and loopback server address were verified before execution and the current migrations applied. No tests or mutations used production.

## Compatibility and release

All frozen iOS and Android clients retain their existing API and normal push/inbox delivery behavior. The retired stage's diagnostic result shape is retained. No app build or upload is required. Do not remove unrelated reconciliation stages.

This branch is based on `f562902` from origin/main, which includes other previously committed work. It is not a declaration that all preceding origin/main changes are authorized for deployment. The runtime change here is limited to the single reconciler file. Production deployment requires fresh user approval and a release based on the verified production ancestry; cherry-pick this scoped change if other main-branch work is not approved.

Independent code review returned SHIP with no blockers, issues or nits. Flutter analysis was clean; no frontend source changed. The accompanying verification evidence records final checks. Production has not been changed by this implementation.
