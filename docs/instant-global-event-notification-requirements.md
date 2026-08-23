# Centralized Notification Delivery Requirements

## Summary & user story

When any notification is ready to send, it should use one reliable delivery
workflow. Scheduled notifications, such as the 2x steps event, should be
released at their intended time; immediate notifications should enter the same
pipeline without waiting for a minute poll. The current event-specific and
notification-specific paths should converge on one delivery mechanism.

## Current findings

- `src/modules/steps/jobs/globalStepEventScheduler.js` polls every 60 seconds.
- Local event boundaries are processed from `processDueEntitlementBoundaries()`.
- Visible notifications are persisted to the Inbox outbox by
  `src/modules/notifications/notificationHandlers.js`.
- `src/modules/inbox/jobs/inboxDelivery.js` polls every 15 seconds.
- Redis is currently used by `src/shared/cache/redisCache.js` as an optional,
  fail-open cache. It is not a durable queue and must not become the sole source
  of notification intent.
- `ecosystem.config.js` already provides a dedicated cron process, while the
  application has only two production HTTP workers. Production capacity must
  remain exactly two HTTP workers.

## Scope

- Centralize notification intent, scheduling, claiming, deduplication, retry,
  provider delivery, and timing metrics for all visible push notifications.
- Add a durable scheduled trigger for global-event starts and any future
  notification that has an explicit `availableAt` time.
- Use Redis only for a low-latency best-effort wake-up after the Postgres
  notification intent is committed.
- Keep the Postgres outbox as the recovery source of truth.
- Add bounded parallel delivery and timing metrics.
- Keep the existing minute scheduler as reconciliation and recovery.

## Non-goals

- No guarantee of exact display time on iOS or Android.
- No changes to event odds, duration, multiplier, scoring, or eligibility.
- No new frontend API contract or app release requirement.
- No production deployment or production migration without explicit approval.
- No release flag or kill switch unless a concrete compatibility or operational
  requirement is demonstrated and explicitly approved.

## Proposed design

1. Every visible notification producer submits a normalized notification intent
   to one shared notification service. The intent includes recipient, type,
   title/body, payload, durable idempotency key, and `availableAt`.
2. Immediate notifications use `availableAt = now`; scheduled notifications use
   their intended release time.
3. The service persists the intent in the existing Postgres Inbox outbox. The
   notification is not visible in the user's Inbox before its release time.
4. Immediate intents create the existing Inbox alert and outbox row in the
   producer transaction. Scheduled global-event intents must not create an Inbox
   alert before their boundary, because older backend versions expose alerts as
   soon as they exist. Instead, the durable event/entitlement boundary creates
   the alert and outbox row when the intent becomes due.
5. After the Postgres commit, publish a best-effort Redis wake-up containing only
   a scan hint. Redis is never the durable schedule.
6. The existing notification delivery worker claims due rows with fenced leases,
   sends through the existing APNs/FCM adapters, and records provider outcomes.
   There must be one sender implementation, not a parallel APNs/FCM path.
7. Delivery uses bounded concurrency. Each recipient remains independently
   deduplicated and retriable.
8. Redis failures, process restarts, and missed wake-ups are recovered by a
   bounded Postgres due-row scan.
9. Push payloads retain the existing `GLOBAL_EVENT_STARTED` type and route so
   frozen iOS/Android clients continue to work.

All notification producers should migrate to this service, including race,
friend, referral, reward, placement, reminder, powerup, and global-event
notifications. Existing callers may keep their public event names and copy;
only the internal delivery path is centralized.

The migration inventory must include every visible producer in
`src/modules/notifications/notificationHandlers.js`,
`src/modules/races/services/raceResolutionDeliveryIntents.js`, admin
notification commands, reminder jobs, and global-event entitlement paths.
Silent/background step-sync pushes are explicitly out of this visible-push
workflow. No producer may call APNs/FCM directly after migration; only the
central delivery worker may do so.

### Producer migration matrix

| Producer family | Existing source | Persistence rule | Delivery key |
|---|---|---|---|
| Global event | `globalStepEventScheduler.js`, `globalStepEventEntitlement.js` | Durable schedule or atomic boundary transaction | `visible:GLOBAL_EVENT_STARTED:{userId}:{eventId}` |
| Race resolution | `raceResolutionDeliveryIntents.js` | Resolution transaction or durable Postgres event row | Existing recipient-scoped source key |
| Race/placement/powerup | `notificationHandlers.js` | Existing domain transaction or durable intent | Stable domain ID + type + recipient |
| Reminders/rewards/referrals | Notification jobs/handlers | Job claim and intent insert are one boundary | Existing reminder/reward/referral key |
| Admin/inbox alerts | `admin/routes.js`, inbox services | Existing alert transaction | Existing `sourceKey` |
| Silent step sync | Native/background sync paths | Excluded from this workflow | Existing silent semantics |

The implementation must fill this matrix with exact notification types,
provider options, and fixture references before removing direct paths.

The deployed Redis service is disposable cache infrastructure (`allkeys-lru`,
without durable AOF/RDB guarantees), so it will not be used as a sorted-set,
stream, delayed queue, or source of scheduled job IDs. Redis is only an optional
best-effort wake-up. The Postgres due-row scan and the existing cron process are
the complete recovery path when `REDIS_URL` is unset or Redis is unavailable.
The wake channel is `${CACHE_ENV_PREFIX}notification:wake`; its message is only
`{"kind":"DUE_SCAN"}`. It carries no notification IDs or payloads. The cron
owner reconnects and runs a bounded scan on wake; a lost wake falls back to a
1-second next-due timer plus the existing reconciliation scan.

## Data model / migrations

Use the existing Inbox outbox schema for immediate notifications. If scheduled
notification intent must be persisted before its boundary, add an additive
Postgres `NotificationSchedule` table with:

- `id`, `recipientUserId`, `type`, `title`, `body`, and complete provider payload
- deterministic recipient-scoped `deliveryKey`
- `availableAt`, optional `expiresAt`, `status`, `createdAt`, `claimedAt`
- source/domain reference and cancellation/staleness metadata
- unique `(recipientUserId, deliveryKey)` and an index on `(status, availableAt)`

Schedule rows are invisible to `/inbox/alerts` and old backend binaries ignore
them. The due-boundary transaction atomically claims a schedule row and creates
the normal Inbox alert/outbox row. Legacy global events and local entitlements
must use the same deterministic key, with eligibility evaluated at the boundary
according to their existing active-race rules. A user joining or leaving before
the boundary must not receive an ineligible event push.

Immediate producers create the Inbox alert and outbox in their existing domain
transaction where possible. If an event bus is used after commit, it may only
wake already-persisted work; it may not be the sole creation path.

Any migration must work while the old backend is still running. No destructive
migration or backfill is expected.

Schedule states are `PENDING → CLAIMED → MATERIALIZED`, with `CANCELLED` and
`EXPIRED` terminal states. Due claims use `SELECT ... FOR UPDATE SKIP LOCKED`.
Terminal rows follow the existing notification retention period. A schedule is
expired when `expiresAt <= now` or its domain source is no longer eligible. The
next indexed `availableAt` is the timer target; the minute scheduler is only
reconciliation.

The existing outbox lease must be fenced with an additive `leaseToken` and every
completion/retry update must match `(id, status, leaseToken)`. Lease expiry is
30 seconds initially, with renewal for long provider calls. The implementation
provides at-least-once provider delivery: a crash after provider acceptance and
before the final database update can produce a duplicate provider request. It
must promise only exactly-once durable intent creation, not exactly-once pushes.

## API contract

No client-facing endpoint or response changes are required. Existing push
payloads remain unchanged:

```json
{
  "type": "GLOBAL_EVENT_STARTED",
  "route": "home"
}
```

Older clients ignore any internal queue metadata and continue receiving the
same notification type and destination.

The internal normalized intent contract is:

```js
{
  recipientUserId,
  type,
  title,
  body,
  payload,
  deliveryKey,
  availableAt,
  expiresAt // optional; stale scheduled notifications are not sent
}
```

Existing notification payload shapes remain intact at the provider boundary.
No app update is required.

The implementation must preserve a golden payload matrix for every visible
notification type, including type, route/destination, route parameters,
multiplier, message IDs, collapse IDs, thread IDs, and any provider-specific
metadata currently consumed by `notification_service.dart`. The centralized
outbox stores and forwards the complete payload rather than reconstructing a
reduced payload from the Inbox destination.

## Rollout and compatibility

- Backend-only change; old app binaries remain compatible.
- A narrow compatibility adapter remains available only when a caller explicitly
  supplies legacy provider doubles without the durable Prisma/outbox surface;
  production wiring always has the Prisma models and routes visible pushes
  through the centralized outbox worker. This adapter is test/degraded-mode
  compatibility, not a second production delivery path.
- Deploy backend code and any additive migration before enabling the new worker
  topology.
- Verify Redis connectivity and queue lag without pointing tests at production.
- Keep the existing Postgres reconciliation path active permanently.
- Do not change production HTTP worker count from two.
- Staging remains off unless explicitly authorized.
- The scheduler and Redis wake subscriber run only in the existing single
  `steps-tracker-cron` owner under `startCrons()`; HTTP workers remain unchanged.
- Redis uses a separately namespaced ephemeral pub/sub wake channel only. A
  missing `REDIS_URL`, Redis restart, publish failure, or subscriber disconnect
  falls back to the Postgres due-row scan.

## Tests-first plan

- Integration-first tests through real command/HTTP paths for every producer
  inventory entry; use structural source guards only for the invariant that
  visible APNs/FCM calls exist solely in the delivery worker.
- Unit tests for durable outbox-to-Redis publication ordering and retry behavior.
- Unit tests for duplicate wake-ups, stale jobs, missed jobs, and Redis outage.
- Integration tests using a dedicated test Postgres and disposable/local Redis:
  event start creates exactly one notification intent and one eventual delivery.
- Integration tests for two worker processes racing to claim the same outbox row.
- Integration tests for bounded parallel delivery and partial provider failure.
- Integration tests for transaction rollback/crash windows and old/new backend
  coexistence during a rolling deploy.
- Integration tests for full payload parity against existing provider fixtures,
  no-token, unregistered-token, permanent rejection, transient failure, timeout,
  partial multi-device success, and retry exhaustion dispositions.
- Integration tests for lease fencing, lease renewal, duplicate wake-ups,
  local Redis DB15, Redis flush/restart/eviction, and `REDIS_URL` unset.
- Integration parity tests proving immediate notifications and scheduled
  notifications use the same claim/send/retry path.
- Timing/observability tests for scheduled, claimed, provider-accepted, and
  retry timestamps.
- Existing notification compatibility/routing tests remain unchanged.

## Acceptance criteria

- Normal event-start notification no longer waits for the one-minute poll.
- Immediate and scheduled visible notifications use the same durable delivery
  workflow.
- No visible notification is released before its `availableAt` time.
- No notification producer retains a direct APNs/FCM send path outside the
  centralized delivery service.
- Duplicate jobs cannot create duplicate durable intents; provider requests are
  explicitly at-least-once after a crash window.
- Redis outage does not lose a notification; Postgres reconciliation delivers it.
- Duplicate jobs cannot produce duplicate pushes.
- A large recipient set is delivered with bounded parallelism.
- Old iOS and Android builds receive the existing payload unchanged.
- Backend unit and integration suites pass using non-production databases.
- `npm run test:unit` and the relevant integration suites are green.
- Architect review and code review are complete before this is called done.

Initial delivery limits are 16 concurrent recipient rows per worker, provider
timeouts of 5 seconds, and retries bounded by the existing exponential retry
schedule. Device dispositions are `ACCEPTED`, `UNREGISTERED`, `PERMANENT_FAIL`,
`TRANSIENT_FAIL`, and `TIMEOUT`; no-token recipients are terminal `NO_DEVICE`.
Per-device attempts/outcomes must be durable so partial failure does not retry
a device that already accepted the push. A row is delivered when all devices
are terminal or accepted, and retries only while transient devices remain.

## Open questions for approval

There are no remaining design choices requiring user input. The implementation
uses Postgres for durability, the existing `ioredis` connection only for
best-effort wake-up, and an initial provider-acceptance target of p95 under 10
seconds from `startsAt`, measured separately from OS display time.

## Revision log

- Initial draft: confirmed Redis is optional cache infrastructure, not yet a
  queue; preserved Postgres outbox and minute reconciliation as safety paths.
- Gap pass 1: added crash/restart recovery, duplicate-claim handling, old-client
  payload compatibility, and bounded concurrency.
- Gap pass 2: added explicit no-flag/no-prod-deploy constraints and test DB/
  disposable Redis requirements.
- User direction: generalized the design from the 2x event to a centralized
  workflow for all visible notifications, with scheduling only where needed.
- Architecture gap corrections: Redis is explicitly non-durable; scheduled
  alerts are created only at their due boundary; the existing Inbox delivery
  worker remains the sole APNs/FCM sender; lease fencing and at-least-once
  provider semantics are explicit; and the PM2 cron owner remains the scheduler.
- Second architecture pass: enumerated direct visible-send producers, required
  transaction-safe intent persistence, defined the additive schedule table and
  recipient-scoped idempotency boundary, required full payload parity, specified
  provider failure dispositions, and added rolling-deploy/Redis recovery tests.
