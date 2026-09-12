# Is missing-device-snapshot notification repair still necessary?

Research record preceding the approved [implementation](notification-snapshot-repair-retirement.md).

Recommendation: retire the five-minute `missingSnapshotsRearmed` scan, while preserving normal notification delivery, retries, lease recovery, and the other reconciler stages. Its incremental protection is low: it revisits malformed terminal outboxes that normal workers intentionally leave finished. No such exception was found in the production audit. This is a researched recommendation, not an implemented removal or a proof that arbitrary database corruption is impossible.

## Scope and production evidence

Production runtime reverified as `0b9b1b7513170abbf6d5207a5b57881f3da667c4`. All source inspection and tests used that revision, exported separately from the local working branch. The earlier materialization-sweep removal, `3ac1bcd`, is already included in production and is distinct from this scan.

At **2026-09-12 21:20:57 UTC**, a repeatable-read, read-only production audit scanned all **21,908 notification schedules**, in 22 pages of at most 1,000 rows. Exact indexed joins followed global-event schedules to alerts/outboxes and checked the outbox-indexed device-attempt existence predicate. It completed in 10.3 seconds with three-second per-statement timeouts. It returned only aggregate counts; no recipient identifiers, device tokens, or notification content were retained.

| Linked global-event outbox state | Delivery window | Has attempt record | Count |
|---|---|---|---:|
| Legacy DELIVERED | Unexpired/no expiry | Yes | 273 |
| Legacy DELIVERED | Expired | Yes | 4,622 |
| Admitted DELIVERED | Unexpired/no expiry | Yes | 2 |
| Admitted DELIVERED | Expired | Yes | 10,937 |
| Admitted EXPIRED | Expired | Yes | 553 |

All **16,387 linked outboxes** had attempt records, including all **275 unexpired/no-expiry outboxes**. There were **zero candidates for this repair**, zero missing-attempt terminal outboxes in this scope, and no linked active retry/lease rows at the snapshot instant. This covers the schedule-linked scope of the existing repair; it is not an audit of every unrelated notification or a statement about future states. Schedules without an outbox are outside this repair's scope and were not classified as missing snapshots.

[Aggregate audit](evidence/notification-snapshot-repair-20260912/audit.jsonl).

Earlier ten-minute monitoring measured two executions, zero rows repaired, 383,846 cached buffer accesses plus 12,934 block reads, and 8.85 seconds cumulative execution elapsed. Those are buffer accesses, not distinct blocks or a direct CPU percentage. These measurements were captured in the preceding ten-minute production observation.

## What already handles normal failures

Source locations refer to the production revision above.

| Situation | Existing owner / behavior |
|---|---|
| New delivery | Producers create PENDING or ADMISSION_FIRST outboxes, not terminal deliveries. `inbox/services/inbox.js:101`, `notificationDelivery.js:572`, `notificationAdmission.js:218`. |
| Normal/legacy claim with no target snapshot | `inboxDelivery.js:1020` creates device-attempt records in a transaction before entering provider delivery. Failure before this completes leaves the parent leased for recovery. |
| Admitted claim with no target snapshot | `notificationAdmission.js:448` calls `snapshotClaimedTargets` before leasing; creation and claim share the transaction. |
| No registered device | Both paths create a `__NO_DEVICE__` attempt. Zero devices therefore does not legitimately mean zero attempt records. |
| Crash or abandoned lease | `claimNormalInboxPage` selects expired LEASED rows; admission selects expired ADMISSION_LEASED rows. A subsequent claim can create missing targets before sending. |
| Provider failure / retry | Attempt dispositions and parent retry timing remain durable. Existing workers retry or expire the delivery without needing this broad audit. |
| Token removal / rotation | Device-token deletion sets the attempt's token reference to null rather than deleting the attempt. Recipient/ownership snapshots remain available for validation. |
| Retention | Inbox expiry deletes the alert and cascades through its outbox and attempts; it does not intentionally retain a live parent while removing its attempts. No runtime standalone attempt-deletion path was found. |

Thus no normal production writer path inspected intentionally produces an unexpired terminal global-event outbox with zero device-attempt records. This is a code-path finding, not a database-enforced invariant: there is no constraint proving every terminal outbox must have an attempt.

## What would be lost by retirement

The scan selects RETRY, LEASED, DELIVERED and EXHAUSTED parents with no attempts, joined to GLOBAL_EVENT_STARTED schedules, and resets them to RETRY. For ordinary retry/expired-lease parents, the delivery worker already supplies the recovery. Its additional behavior is reopening terminal DELIVERED/EXHAUSTED parents after missing-attempt corruption, a historical bug, a manual deletion, or a future writer defect.

Retiring it means such malformed terminal records would require an explicit bounded audit/repair rather than automatic reopening every five minutes. That is the actual tradeoff. Nothing in the production snapshot demonstrated a current need for that recovery.

The existing scan also has limitations: it does not inspect ADMISSION_FIRST/ADMISSION_RETRY/ADMISSION_LEASED states, does not require a selected legacy LEASED row to have expired, and the final UPDATE does not recheck the candidate's status/lease/no-attempt condition. It can therefore interfere with a legacy claim in the claim-to-snapshot interval; that is a source-level concurrency concern, not a reproduced production incident. It is not a comprehensive notification-integrity guarantee.

## Verification

Created a dedicated local `bara_notification_research_20260912_test` database, verified its name and loopback server address, and applied the deployed revision's migrations. No tests targeted production. Ran unchanged existing tests against the separately exported deployed code:

- `centralized-notification-delivery.test.js` and `event-surge-notification-admission.test.js`: **26 passed**.
- Five targeted cases from `global-event-reliability.test.js`: **5 passed**, covering snapshot/repair behavior, installation target persistence across rotation, a pre-migration retry, Retry-After scheduling, and attribution.

These are existing database-backed tests; several invoke worker/service entrypoints directly, so they are not all end-to-end HTTP proofs. Provider services are test doubles, not live Apple/Firebase sends. They establish the current recovery mechanisms and do not by themselves prove a future removal is correct. The first test invocation failed on missing test-only SESSION_TOKEN_SECRET; after supplying an explicit local test value, the relevant runs passed. No assertions were changed or skipped to force success.

The current repair test explicitly manufactures an overdue LEASED outbox with no attempts and expects `missingSnapshotsRearmed=1`; it does not demonstrate a current writer creating an unrecoverable terminal gap. That existing assertion must be surfaced during a removal change, not silently weakened.

## Concrete next implementation scope

1. Remove only `missingSnapshotsRearmed` SQL; retain the result field with a documented zero if required by internal callers, following the earlier materialization-removal pattern.
2. Preserve normal claims, retry timing, lease recovery, device snapshots, no-device records, admission pacing, and unrelated repair stages.
3. Before changing logic, add public-path integration coverage exercising claim interruption/recovery and ordinary delivery without the scan; explicitly reconcile the now-obsolete repair-specific expectation with the approved behavior change. Preserve assertions for other stages.
4. No feature flag, schema migration, app update, or release configuration change is needed for this scope. Old app versions retain the same notification API and normal delivery semantics. The intentional behavior change is limited to automatic recovery of malformed terminal data.
5. Run the required code review, then obtain fresh production-deployment approval. No production mutation or deployment was performed by this research.
