# Notification Domain Isolation Requirements

## Summary & user story

As a user performing gameplay, social, tournament, reward, or support actions,
the action's correctness must never depend on notification scheduling,
materialization, Inbox creation, Redis, APNs, or FCM. A notification is a
downstream consequence of committed domain state, not part of deciding or
committing that state.

As an operator, every visible notification must still have a durable,
idempotent handoff so a process crash after the domain commit cannot silently
lose it. The existing Postgres Inbox/push outbox remains the sole provider
delivery path; this feature adds an earlier, notification-agnostic domain-event
handoff and removes notification implementation calls from domain transactions.

The target dependency direction is:

```text
domain command transaction
  -> durable domain event
  -> post-commit notification projection
  -> Inbox alert + push outbox
  -> APNs/FCM worker
```

No arrow points back toward domain state. Notification projection or delivery
failure cannot roll back, delay, activate, cancel, or otherwise mutate the
domain fact that produced it.

## Current findings

- Local 2x event boundary processing creates race impacts, enqueues race
  resolution, releases a notification schedule, creates Inbox/outbox rows, and
  marks the entitlement active in one transaction in
  `src/modules/steps/services/globalStepEventEntitlement.js`. A notification
  materialization exception rolls back gameplay activation.
- Future local-entitlement creation calls
  `notificationIntentService.submit()` in its entitlement transaction, so a
  notification write can prevent the entitlement from existing.
- Legacy global-event creation, all participant enrollment snapshots, and all
  recipients' notification intents share one transaction in
  `src/modules/steps/models/globalStepEvent.js`. One recipient's notification
  intent can abort the whole event.
- Admin support reply creation calls the notification service in the same
  transaction in `src/modules/admin/routes.js`; notification failure can abort
  a valid support message.
- Most other producers emit through `src/shared/events/eventBus.js`. This bus
  is process-local, does not await handlers, has no durable cursor, and cannot
  recover an event lost between domain commit and notification-intent creation.
- Several producers persist a notification claim or advance a
  `lastNotified*` marker before an ephemeral emit. A crash can suppress the
  notification permanently because later scans see the claim as consumed.
- Some commands use `deferUntilAfterCommit`, which prevents pre-commit reads
  but remains an in-memory callback and therefore does not close the crash gap.
- Actual provider delivery is already correctly isolated behind
  `InboxDeliveryOutbox`. APNs/FCM failures do not roll back domain work and that
  boundary will be retained.

## Goals

- Make domain state independent of notification code and notification tables.
- Preserve a durable, exactly-once intent-creation boundary with idempotent
  retries and at-least-once downstream processing.
- Eliminate the process-local event bus as the sole source of any visible
  notification.
- Preserve all current Inbox content, push copy, payloads, destinations,
  recipient rules, cooldowns, scheduling, and frozen-client behavior.
- Make each notification producer independently retryable without blocking
  unrelated users or domain work.
- Establish structural enforcement so the coupling cannot be reintroduced.

## Scope

- All visible notification producers registered in
  `src/modules/notifications/notificationHandlers.js`.
- Global-event notification scheduling and release, including local and legacy
  schedule modes.
- Race, placement, powerup, tournament, friendship, referral, reminder,
  reward, support, and race-message notifications.
- Notification-specific claims, cooldowns, deduplication, Inbox projection,
  push-outbox creation, wake-up, retries, and reconciliation.
- A durable domain-event outbox and a notification projection worker running
  under the existing cron owner.
- Removal of notification-service calls from domain transactions and removal
  of visible-notification correctness dependence on `eventBus`.

## Non-goals

- No change to event timing, eligibility, multiplier, scoring, steps, race
  settlement, odds, economy, or payouts.
- No change to notification wording, recipient policy, cooldown policy, Inbox
  visibility, navigation, or provider payloads except to fix proven parity
  defects discovered by tests.
- No client-facing API or Flutter UI change.
- No exactly-once promise for APNs/FCM display. Provider delivery remains
  at-least-once across the acceptance/database-update crash window.
- No external broker. Postgres is the durable source; Redis remains an
  optional best-effort wake-up only.
- No feature flag, rollout percentage, kill switch, or new production worker.
- Silent/background step-sync pushes remain outside the visible-notification
  pipeline. The mixed race-message and placement handlers' silent refresh
  branches are explicitly split into the silent-refresh projection described
  below; structural tests distinguish both from visible Inbox delivery.
- No production deployment, migration, data repair, or staging startup without
  the separately required authorization.

## Required architecture

### 1. Domain transaction boundary

Domain commands may write only their domain state and a generic durable domain
event. They must not import or invoke:

- `notificationIntentService`
- `createInboxAlert`
- `NotificationSchedule`
- Inbox delivery code
- APNs, FCM, device-token, or Redis notification code

The durable event writer accepts only an event name, immutable aggregate/source
ID, schema version, occurred-at timestamp, and JSON domain facts. It performs no
notification validation, recipient lookup, copy construction, routing, Inbox
write, or wake-up. Therefore notification implementation changes cannot make a
domain command fail.

Writing this generic event in the same Postgres transaction is deliberate: it
closes the commit/crash gap while remaining domain infrastructure rather than a
notification operation. A database outage can still fail the transaction, but
a notification schema, handler, payload, provider, token, Redis, or Inbox
failure cannot.

### 2. Durable domain-event outbox

Add an append-only `DomainEventOutbox` table. Producers use deterministic
event identities so transaction retries and concurrent writers cannot create
duplicate logical events.

The notification projector claims committed rows using short transactions and
`FOR UPDATE SKIP LOCKED`. Handler work occurs per event or per bounded recipient
batch so one malformed event or recipient cannot block unrelated events.

Fan-out is two-stage and resumable. First, an event-type projector resolves a
stable recipient set from immutable payload IDs or committed domain rows and
upserts recipient-scoped projection rows. Then workers materialize each
recipient projection independently. Large fan-outs page by a stable primary-key
cursor; the parent event is not completed until recipient expansion is
exhausted and every child projection is terminal. A failed recipient therefore
cannot retain the parent lease or block later recipients.

Projection is at-least-once. Every generated notification uses its existing
deterministic delivery key, making Inbox alert and push-outbox creation
idempotent. A projection row is marked complete only after all of its intended
notification intents are durably materialized or explicitly recorded as a
terminal no-delivery outcome.

### 3. Notification projection boundary

The projector owns:

- recipient resolution and eligibility revalidation;
- notification copy and complete payload construction;
- notification claims, cooldowns, and deduplication;
- scheduled intent creation/cancellation/expiration;
- Inbox alert and push-outbox materialization;
- notification metrics and best-effort Redis wake-up.

Projection failures update only domain-event projection state and retry
metadata. They never update entitlement activation, race impact, steps, race
membership, tournament state, coins, rewards, friendship state, or support
messages.

### 4. Global 2x events

Local event behavior is split into independent facts:

1. Entitlement provisioning commits the entitlement only. It never schedules a
   notification or emits a notification-domain event.
2. At the start boundary, gameplay processing fences races, creates impact
   rows, enqueues race recalculation, and marks the entitlement outcome in one
   gameplay-only transaction.
3. That same transaction appends
   `GLOBAL_STEP_EVENT_ACTIVATED_V1` only when at least one race impact exists.
4. Notification projection consumes the activation event and creates the
   scheduled/due Inbox notification independently.
5. If gameplay activation fails, no activation event commits and no start
   notification can be produced.
6. If notification projection fails, activation and 2x scoring remain
   committed and projection retries independently.

The notification schedule cannot be used as the boundary clock for gameplay.
`startsAt`/`endsAt`, entitlement state, and race impacts are the only scoring
inputs. Actual step samples remain timestamp-based, so delayed notification
processing never changes which steps receive the multiplier.

Legacy global events commit the event, participant impact snapshot, occurrence-
time audience snapshot, and one durable activation event without writing
recipient notification rows. Preserve the established C0 correctness path:
race recalculation delivery remains the responsibility of the existing fenced
global boundary cursor and race-resolution queue after this commit. The new
projector never enqueues race resolution and never writes `race_participants`,
entitlements, impacts, or any other gameplay row.

### 5. Other producers

Each existing visible event receives a versioned domain-event contract. The
implementation inventory must cover every handler currently registered in
`notificationHandlers.js`, including:

- friend request sent/accepted;
- race invite sent/accepted, buy-in changed, uneven scheduled teams, race
  started/ending/completed/cancelled, race messages, and placement/team alerts;
- powerup use and high-multiplier alerts;
- referral rewards and daily/milestone/mover reminders;
- tournament invite/start/round/result/completion/cancellation events;
- support replies;
- global event activation.

For domain operations that already commit before emitting, replace the
ephemeral emit with an atomic domain-event append in the owning transaction.
For cron-derived observations, atomically claim the observation and append the
domain event; do not advance `lastNotified*` or cooldown state unless the event
append commits. Notification-specific cooldown claims move into projection.

`eventBus` may remain for non-visible, non-durable internal hints during the
migration, but no visible notification may rely on it for correctness when the
work is complete.

### Mixed visible and silent handlers

`RACE_MESSAGE_SENT` and `PLACEMENT_CHANGED` currently contain both visible
Inbox behavior and direct silent refresh sends. Migration splits them after the
durable domain event:

- The event-type projector applies the existing classification/cooldown rules
  and creates either a `VISIBLE` recipient projection or a `SILENT_REFRESH`
  recipient projection, never both for the same occurrence/recipient unless an
  existing golden test proves both were intentionally sent.
- `VISIBLE` uses normal Inbox/outbox materialization.
- `SILENT_REFRESH` is consumed by
  `src/modules/notifications/services/silentRefreshDelivery.js` through an
  injected `buildSilentRefreshDelivery(dependencies = {})`. It creates no Inbox
  alert, preserves the existing payload, device lookup, APNs/FCM routing,
  unregistered-token deletion, and chat/placement cooldown semantics, and
  records retry/terminal state on the projection row.
- Race-message silent refresh uses the deterministic transport/projection key
  `silent:RACE_MESSAGE_SENT:{messageId}:{recipientUserId}`. Placement silent
  refresh uses
  `silent:PLACEMENT_CHANGED:{transitionId}:{recipientUserId}`. These are
  intentional new durable keys: the legacy silent branches have no persisted
  transport key, so there is no old durable key with which to collide during
  mixed deployment. The domain-event idempotency key prevents the new path from
  creating a second projection.
- The old combined handlers become compatibility adapters only during mixed
  deployment. They call distinct visible and silent functions; the silent path
  cannot call or re-enter visible projection, and the visible path cannot call
  direct provider delivery.
- Silent/background step-sync retains its existing race-resolution handoff and
  is not routed through this new worker.

Integration tests exercise race chat on and off cooldown and meaningful versus
non-meaningful placement changes. Structural tests prove silent refresh never
creates Inbox rows and neither mixed handler contains inline provider/token
logic after migration.

### Producer contract matrix

For this matrix, `EK(T,S)` means domain `eventKey = T + ":" + S`; `DK(P,U,S)`
means the existing `canonicalPushDeliveryKey(publicType=P, recipient=U,
sourceId=S)`. “Snapshot” means the named recipient IDs and per-recipient facts
are written atomically as `DomainEventAudience` rows. Unless an expiry is named,
the event has no pre-Inbox expiry. Copy and provider payloads remain the exact
golden fixtures extracted from the named existing handler; implementation may
move them but may not alter them.

| V1 domain event / existing handler | Immutable V1 payload and occurrence audience | Event key / delivery key | Eligibility, expiry, ordering, copy source |
|---|---|---|---|
| `FRIEND_REQUEST_SENT_V1` / `FRIEND_REQUEST_SENT` | `{friendshipId, requesterId, addresseeId}`; addressee snapshot | `EK(T,friendshipId)` / exact legacy `DK(FRIEND_REQUEST_SENT,U,requesterId+":"+addresseeId)` | Suppress only deleted recipient; friendship aggregate order; current handler lines 293–316 |
| `FRIEND_REQUEST_ACCEPTED_V1` / same | `{friendshipId, accepterId, requesterId}`; requester snapshot | `EK(T,friendshipId)` / exact legacy `DK(FRIEND_REQUEST_ACCEPTED,U,friendshipId || requesterId+":"+accepterId)` | Deleted recipient only; friendship order; lines 317–341 |
| `RACE_INVITE_SENT_V1` / same | `{raceId,raceName,creatorUserId,inviteId}`; invitee snapshot | `EK(T,inviteId)` / `DK(RACE_INVITE_SENT,U,raceId)` | Deleted recipient only; race order; lines 342–365 |
| `RACE_INVITE_ACCEPTED_V1` / same | `{raceId,raceName,participantId,userId,creatorUserId}`; creator snapshot | `EK(T,participantId)` / `DK(RACE_INVITE_ACCEPTED,U,raceId)` | Deleted recipient only; race order; lines 366–391 |
| `RACE_BUYIN_CHANGED_V1` / same | `{raceId,raceName,newBuyIn,changeId}`; affected users snapshot | `EK(T,changeId)` / `DK(RACE_BUYIN_CHANGED,U,"race-buyin:"+changeId)` | Intentional key introduction: current handler drops events missing `notificationIntentId` and no producer currently emits this type; new edit revision ID is required before enabling the producer, so there is no old durable key to overlap; race order; lines 392–427 |
| `RACE_SCHEDULED_TEAMS_UNEVEN_V1` / same | `{raceId,creatorUserId,attemptKey}`; creator snapshot | `EK(T,"cron:TEAM_RACE_SCHEDULED_UNEVEN:"+raceId+":"+creatorUserId)` / exact legacy `DK(TEAM_RACE_SCHEDULED_UNEVEN,U,raceId)` | Existing once-per-race claim becomes event append; race order; lines 428–451 |
| `RACE_STARTED_V1` / same | `{raceId,raceName,creatorUserId,isTeamRace,teamAName,teamBName,isSeededBucket}`; non-creator participants snapshot | `EK(T,raceId)` / `DK(RACE_STARTED,U,raceId)` | Suppress tournament/seeded bucket exactly as today before append; race order; lines 452–506 |
| `RACE_ENDING_SOON_V1` / same | `{raceId,raceName,endsAt,observationKey}`; candidate user snapshot | `EK(T,"cron:RACE_ENDING_SOON:"+raceId+":"+U)` / exact legacy `DK(RACE_ENDING_SOON,U,raceId)` | Append atomically with observation claim; expire at `endsAt`; race order; lines 507–556 |
| `DAILY_REWARD_REMINDER_V1` / same | `{userId,slot,title,body,localDate}`; user snapshot | `EK(T,"daily-reward:"+U+":"+localDate+":"+slot)` / exact legacy `DK("DAILY_REWARD_REMINDER_"+slot,U,U+":"+localDate+":"+slot)` | Eligibility decided by reminder job before append; expire at end of local date; user/date order; lines 557–587 |
| `STEP_MILESTONE_REMINDER_V1` / same | `{userId,title,body,localDate}`; user snapshot | `EK(T,"step-milestone:"+U+":"+localDate)` / exact legacy `DK(STEP_MILESTONE_REMINDER,U,U+":"+localDate)` | Job eligibility before append; expire at local midnight; user/date order; lines 588–615 |
| `RACE_COMPLETED_V1` / same | `{raceId,completionId,winnerUserId,winnerTeam,tie,winnerTeamName,loserTeamName}`; participant IDs and `memberTeam` facts snapshot | `EK(T,completionId)` / `DK(RACE_COMPLETED,U,raceId)` | Suppress tournament matchup before append; race order; lines 616–679 |
| `TEAM_LEAD_CHANGED_V1` / same | `{raceId,raceName,leadingTeamName,trailingTeamName,transitionId}`; member snapshot | exact producer `transitionId="team-lead:"+raceId+":"+previousLeader+"->"+leadingTeam+":"+fiveMinuteBucket`; `EK(T,transitionId)` / exact legacy `DK(TEAM_LEAD_CHANGE,U,transitionId)` | Persisted projector cooldown replaces process map; expire race end if present; race order; public type remains `TEAM_LEAD_CHANGE`; lines 680–743 |
| `TEAM_FINAL_STRETCH_V1` / same | `{raceId,raceName,teamATotal,teamBTotal,endsAt,transitionId}`; member IDs and `memberTeam` facts snapshot | exact producer `transitionId="team-final-stretch:"+raceId+":"+floor(nowMs/1800000)`; `EK(T,transitionId)` / exact legacy `DK(TEAM_FINAL_STRETCH,U,transitionId)` | Persisted per-recipient throttle; expire `endsAt`; race order; lines 744–812 |
| `TEAM_SLACKER_NUDGE_V1` / same | `{raceId,raceName,teamName,observationKey}`; candidate user snapshot | `EK(T,"cron:TEAM_SLACKER_NUDGE:"+raceId+":"+U)` / exact legacy `DK(TEAM_SLACKER_NUDGE,U,raceId)` | Append with observation claim; expire race end if present; race order; lines 813–857 |
| `REFERRAL_REWARDED_V1` / same | `{rewardTransactionId,referrerId,refereeId,coins}`; referrer snapshot | `EK(T,rewardTransactionId)` / `DK(REFERRAL_REWARDED,U,referrerId:refereeId)` | Requires committed reward transaction; referral order; lines 858–886 |
| `RACE_CANCELLED_V1` / same | `{raceId,raceName,cancellationId,creatorUserId}`; participants snapshot | `EK(T,cancellationId)` / `DK(RACE_CANCELLED,U,raceId)` | Cancellation committed; race order; lines 887–910 |
| `GLOBAL_STEP_EVENT_ACTIVATED_V1` / `GLOBAL_EVENT_STARTED` | Local: `{eventId,entitlementId,multiplier,startsAt,endsAt}` and one eligible user; legacy: event facts plus impacted-user snapshot | local `EK(T,entitlementId)`, legacy `EK(T,eventId)` / `visible:GLOBAL_EVENT_STARTED:U:eventId` | Tri-state activation/impact eligibility; expire `endsAt`; event order; lines 911–983 |
| `POWERUP_USED_V1` / same | `{powerupId,raceId,actorUserId,powerupType,targetUserId,upgradeLevel,stealthed,occurredAt}`; target snapshot | `EK(T,powerupId+":"+targetUserId)` / exact legacy `DK(POWERUP_USED,U,notificationIntentId)` where current producers use `powerup:powerupId` or `powerup:powerupId:targetUserId` | Preserve self/unsupported/live-race suppression; expire at race end; race order; lines 984–1064 and existing formatter fixtures |
| `RACE_MESSAGE_SENT_V1` / same | `{raceId,messageId,senderId,senderName,raceName}`; accepted, unmuted non-sender audience and `lastChatPushAt` facts snapshot | `EK(T,messageId)`; visible `DK(race_message,U,messageId)`; silent `silent:RACE_MESSAGE_SENT:messageId:U` | Message remains canonical body source; persisted 60s recipient cooldown; race/message order; lines 1065–1272 |
| `PLACEMENT_CHANGED_V1` / same | `{transitionId,raceId,raceName,userId,previousPlacement,placement,paidPlaces,endsAt}`; user snapshot | exact producer `transitionId="placement:"+participantId+":"+fiveMinuteBucket+":"+previousPlacement+"->"+placement`; `EK(T,transitionId)`; exact legacy visible key: payout drop `DK(PLACEMENT_CHANGED,U,"payout-drop:"+raceId+":"+U)`, otherwise `DK(PLACEMENT_CHANGED,U,transitionId)`; silent `silent:PLACEMENT_CHANGED:transitionId:U` | Existing visibility/time-window classification before append; expire race end; race order; lines 1273–1480 |
| `HIGH_MULTIPLIER_ALERT_V1` / production race-resolution path | One crossing parent `{raceId,sourceGeneration,actorUserId,actorName,multiplier,stealthed}` with all rivals as audience rows | parent `EK(T,"race-resolution:"+raceId+":"+sourceGeneration+":"+actorUserId)`; per-recipient source `S="race-resolution:"+raceId+":"+sourceGeneration+":"+actorUserId+":"+U`; exact production `DK(HIGH_MULTIPLIER_ALERT,U,HMAC_SHA256(SESSION_TOKEN_SECRET,S))` | Preserve participant claim and one-per-day recipient claim in projection; expire race end; parity test invokes `raceResolutionDeliveryIntents.claimHighMultiplier`, not only the legacy event-bus handler; older crossing event remains compatibility-only; lines 1481–1568 and raceResolutionDeliveryIntents lines 40–145 |
| `TOURNAMENT_INVITE_SENT_V1` / same | `{inviteId,tournamentId,tournamentName,creatorUserId,bracketSize,potCoins}`; invitee snapshot | `EK(T,inviteId)` / `DK(TOURNAMENT_INVITE_SENT,U,tournamentId)` | Deleted recipient only; tournament order; lines 1569–1598 |
| `TOURNAMENT_STARTED_V1` / same | `{tournamentId,roundId,raceId,opponentName,days}`; user and opponent-display facts snapshot | `EK(T,roundId:U)` / `DK(TOURNAMENT_STARTED,U,raceId)` | Committed matchup; tournament/user order; lines 1599–1623 |
| `TOURNAMENT_ROUND_STARTED_V1` / same | `{tournamentId,roundId,raceId,label,opponentName,days}`; user snapshot | `EK(T,roundId:U)` / `DK(TOURNAMENT_ROUND_STARTED,U,raceId)` | Committed matchup; tournament/user order; lines 1624–1647 |
| `TOURNAMENT_MATCHUP_WON_V1` / same | `{tournamentId,matchupId,nextLabel}`; winner snapshot | `EK(T,matchupId:U)` / `DK(TOURNAMENT_MATCHUP_WON,U,tournamentId)` | Committed result; tournament/user order; lines 1648–1671 |
| `TOURNAMENT_ELIMINATED_V1` / same | `{tournamentId,matchupId,label,opponentName}`; eliminated user snapshot | `EK(T,matchupId:U)` / `DK(TOURNAMENT_ELIMINATED,U,tournamentId)` | Committed result; tournament/user order; lines 1672–1696 |
| `TOURNAMENT_CHAMPION_V1` / same | `{tournamentId,completionId,tournamentName,prizeCoins}`; champion snapshot | `EK(T,completionId:U)` / `DK(TOURNAMENT_CHAMPION,U,tournamentId)` | Committed prize/result; tournament/user order; lines 1697–1724 |
| `TOURNAMENT_COMPLETED_V1` / same | `{tournamentId,completionId,tournamentName,championName}`; non-champion/follower recipients snapshot | `EK(T,completionId:U)` / `DK(TOURNAMENT_COMPLETED,U,tournamentId)` | Dormant compatibility-only projector: the 2026-07-25 D1 decision retired this fan-out in favor of one `TOURNAMENT_CHAMPION` or `TOURNAMENT_ELIMINATED` result per player; no current producer; tournament/user order; lines 1725–1748 |
| `TOURNAMENT_CANCELLED_V1` / same | `{tournamentId,cancellationId,tournamentName}`; affected users plus per-user `buyInAmount` snapshot | `EK(T,cancellationId:U)` / `DK(TOURNAMENT_CANCELLED,U,tournamentId)` | Committed cancellation/refund; tournament/user order; lines 1749–1778 |
| `DAILY_MOVER_V1` / same | `{digestId,userId,raceId,raceName,movement,placement,localDate}`; user snapshot | exact producer `digestId="daily-mover:"+runKey+":"+U`; `EK(T,digestId)` / exact legacy `DK(DAILY_MOVER,U,digestId)` | Append with daily digest claim; choose max `absMovement`, then deterministically lowest `raceId` among ties; expire end of digest day; user/date order; lines 1779 onward |

`SUPPORT_REPLY_CREATED_V1` is not currently an event-bus registration but is in
scope: payload `{messageId,threadId,userId}`, user snapshot, event key
`SUPPORT_REPLY_CREATED_V1:messageId`, delivery key `support-reply:messageId`,
thread aggregate order, copy read from the committed message, and suppression
only for deleted recipient or expired/deleted thread according to existing
Inbox behavior.

The implementation must create a checked-in literal fixture before changing
each producer. If the current handler lacks a stable source ID, the owning transaction adds an
immutable transition/observation ID as domain data; it must not use a random ID
generated by notification projection.

## Data model and migrations

Add these exact additive Prisma shapes (migration SQL adds the stated bounded
`varchar` types where Prisma schema annotations are shown):

```prisma
model DomainEventOutbox {
  id                   String    @id @default(uuid())
  eventKey             String    @unique @db.VarChar(255) @map("event_key")
  eventType            String    @db.VarChar(96) @map("event_type")
  schemaVersion        Int       @default(1) @map("schema_version")
  aggregateType        String    @db.VarChar(64) @map("aggregate_type")
  aggregateId          String    @db.VarChar(191) @map("aggregate_id")
  payload              Json
  occurredAt           DateTime  @map("occurred_at")
  availableAt          DateTime  @map("available_at")
  status               String    @default("PENDING") @db.VarChar(32)
  expansionCursor      String?   @db.VarChar(191) @map("expansion_cursor")
  expansionCompletedAt DateTime? @map("expansion_completed_at")
  leaseToken           String?   @db.VarChar(64) @map("lease_token")
  leaseUntil           DateTime? @map("lease_until")
  attemptCount         Int       @default(0) @map("attempt_count")
  lastErrorCode        String?   @db.VarChar(128) @map("last_error_code")
  lastErrorAt          DateTime? @map("last_error_at")
  completedAt          DateTime? @map("completed_at")
  createdAt            DateTime  @default(now()) @map("created_at")
  updatedAt            DateTime  @default(now()) @updatedAt @map("updated_at")

  audience    DomainEventAudience[]
  projections DomainEventNotificationProjection[]

  @@index([status, availableAt, occurredAt])
  @@index([aggregateType, aggregateId, occurredAt])
  @@index([leaseToken])
  @@map("domain_event_outbox")
}

model DomainEventAudience {
  id            String   @id @default(uuid())
  domainEventId String   @map("domain_event_id")
  recipientId   String   @db.VarChar(191) @map("recipient_id")
  ordinal       Int
  facts         Json     @default("{}")
  createdAt     DateTime @default(now()) @map("created_at")

  event DomainEventOutbox @relation(fields: [domainEventId], references: [id], onDelete: Cascade)

  @@unique([domainEventId, recipientId])
  @@unique([domainEventId, ordinal])
  @@index([domainEventId, ordinal])
  @@map("domain_event_audiences")
}

model DomainEventNotificationProjection {
  id              String    @id @default(uuid())
  domainEventId   String    @map("domain_event_id")
  recipientUserId String    @db.VarChar(191) @map("recipient_user_id")
  deliveryKey     String    @db.VarChar(255) @map("delivery_key")
  projectionKind  String    @db.VarChar(32) @map("projection_kind")
  status          String    @default("PENDING") @db.VarChar(32)
  availableAt     DateTime  @map("available_at")
  leaseToken      String?   @db.VarChar(64) @map("lease_token")
  leaseUntil      DateTime? @map("lease_until")
  attemptCount    Int       @default(0) @map("attempt_count")
  lastErrorCode   String?   @db.VarChar(128) @map("last_error_code")
  completedAt     DateTime? @map("completed_at")
  createdAt       DateTime  @default(now()) @map("created_at")
  updatedAt       DateTime  @default(now()) @updatedAt @map("updated_at")

  event DomainEventOutbox @relation(fields: [domainEventId], references: [id], onDelete: Cascade)

  @@unique([domainEventId, recipientUserId, deliveryKey, projectionKind])
  @@index([status, availableAt, id])
  @@index([leaseToken])
  @@map("domain_event_notification_projections")
}
```

Audience rows are generic occurrence-time domain snapshots, not notification
rows. `recipientId` and projection `recipientUserId` deliberately have no
foreign key to `User`: deleting an account must never be blocked by event or
notification coordination history. Projection handles a missing user as a
terminal suppression. Audience/projection children cascade only when retention
deletes their parent event.

Immutable columns are `eventKey`, `eventType`, `schemaVersion`,
`aggregateType`, `aggregateId`, `payload`, `occurredAt`, and audience rows.
Only status/lease/attempt/error/completion/cursor columns are mutable. Fan-out
pages audience by `ordinal`; cursor updates and projection upserts commit
atomically. Parent completion requires `expansionCompletedAt != null` and no
non-terminal child. Projectors must not store notification body text, device
tokens, or provider credentials in coordination rows.

`projectionKind` is required, immutable after insert, and exactly `VISIBLE` or
`SILENT_REFRESH`. Claim/replay routes only from this persisted value and never
re-runs time-sensitive classification. Visible projection always materializes
Inbox/outbox. Silent refresh projection never creates an Inbox row and is
delivered by the named silent-refresh worker described below.

Completion/retry updates must match both `id` and `leaseToken`. Expired leases
are reclaimable. Store bounded error codes/metadata, not device tokens or
unbounded stack traces.

Existing `NotificationSchedule`, `InboxAlert`, `InboxDeliveryOutbox`, and
per-device attempt tables remain additive downstream structures. Do not drop or
repurpose them during this migration. Old backend processes ignore the new
table.

No historical backfill is required for already completed domain operations.
Pending notification schedules existing at deploy time continue through the
old reconciliation path until terminal. The implementation must provide a
finite compatibility drain based on row state, not time or a runtime flag; new
domain work uses the new outbox immediately after deployment.

For existing `GLOBAL_EVENT_STARTED` schedules, the compatibility eligibility
check is tri-state, not boolean:

- `ELIGIBLE`: an eligible entitlement outcome and applicable committed impact
  exist; materialize independently.
- `PENDING_ACTIVATION`: the event window is live and the entitlement is still
  `PENDING`; leave the schedule `PENDING` and retry with bounded backoff.
- `INELIGIBLE_TERMINAL`: the entitlement is `NO_ACTIVE_RACES` or
  `SKIPPED_STALE`, the recipient/source was deleted, or the schedule expired;
  cancel/expire with its explicit reason.

This prevents a scanner that runs immediately before or concurrently with the
gameplay boundary from mistaking “not committed yet” for terminal ineligibility.
The schedule materializes only after activation and cannot roll activation
back.

Retention is required in the initial release because every visible notification
creates coordination rows. A cron-owner-only idempotent cleanup runs daily via
the established `JobRun` claim pattern. It may delete a parent and cascading
children only when the parent and every child are terminal, at least 30 days
have elapsed since parent completion, and no linked notification schedule,
Inbox outbox, or per-device attempt remains non-terminal. It processes bounded
pages and retries safely after partial progress. Non-terminal and failed rows
are never age-deleted. Tests cover parent/child cascade, account deletion,
active downstream work, and cleanup replay.

## Internal contracts

There are no new or changed client endpoints.

The internal append contract is:

```js
appendDomainEvent(tx, {
  eventKey,       // deterministic and immutable
  eventType,      // versioned, e.g. GLOBAL_STEP_EVENT_ACTIVATED_V1
  schemaVersion,  // initially 1
  aggregateType,
  aggregateId,
  occurredAt,
  availableAt,   // defaults to occurredAt
  payload,        // domain facts only
})
```

The append is create-or-confirm-identical. Reusing an `eventKey` with different
type, aggregate, version, or payload is a hard invariant violation and must not
silently overwrite the original event.

The canonical serialized payload is limited to 64 KiB. The generic append
repository rejects larger payloads before issuing its insert. Large audiences
belong in paged `DomainEventAudience` rows, not the JSON envelope.

Every V1 payload uses immutable IDs and facts needed for deterministic
projection. Projectors may query current state for eligibility, recipient, or
display-name data where notification semantics require current state. Payloads
must not embed device tokens or provider-specific credentials.

Payloads follow data minimization. Support events contain the committed message
ID and thread ID, not a duplicate message body; the projector reads the
committed message. Event types whose existing copy intentionally captures a
name/value at occurrence time may store that bounded display fact. Event
payloads must never contain auth tokens, provider credentials, device tokens,
or unrestricted request bodies.

The implementation must add a checked-in producer matrix documenting, for each
event type: owning command/job, transaction boundary, event key, payload,
recipient lookup, eligibility timing, delivery key, copy/payload fixture,
cooldown, expiry, and terminal no-delivery outcomes.

The matrix and projector registry must be mechanically compared with the set of
visible handlers at test time. Adding a visible notification handler without a
registered versioned domain event and parity fixture fails CI. Migration is not
complete while any matrix row names `eventBus` or an after-commit callback as
its only durable source.

## Client API and frontend plan

No client API response changes are required. Existing Inbox endpoints and push
payloads are byte-for-byte compatible at the semantic field level. Frozen iOS
and Android clients continue receiving the same public notification `type`,
route, parameters, collapse identifiers, and content.

No Flutter files, screens, widgets, demo/tutorial surfaces, assets, or platform
configuration change. No app release is required.

## Failure semantics

- Domain event append fails: the owning domain transaction fails because its
  durable fact could not be recorded. This is a database/domain-infrastructure
  failure, not a notification implementation failure.
- Projector crashes before intent creation: lease expires and the event retries.
- Projector crashes after intent creation but before completion: deterministic
  keys make replay idempotent.
- One recipient is malformed: record/retry that recipient independently;
  unrelated recipients and events continue.
- NotificationSchedule/Inbox/outbox write fails: projection retries; domain
  state remains committed.
- Redis publish/subscription fails: Postgres scan recovers.
- APNs/FCM fails: existing per-device retry/disposition behavior applies.
- No token, disabled OS push permission, or unregistered device: projection
  still creates the same Inbox alert and push-outbox row. `NO_DEVICE_TOKEN`,
  disabled, and unregistered dispositions belong only to the downstream
  delivery worker; frozen clients retain Inbox history. Pre-Inbox suppression
  is allowed only for recipient deletion or an event-specific eligibility rule
  explicitly listed in the producer matrix. Domain state is unchanged.
- Event is no longer notification-eligible when projected: mark an explicit
  terminal suppression outcome without mutating the domain source.
- Poison event exceeds the bounded retry policy: mark `FAILED_TERMINAL`, emit
  an operational alert/metric, retain it for investigation, and leave the
  source domain state untouched. Provide an idempotent operator replay command
  accepting explicit event/projection IDs; it is never run against production
  without the separately required data-write authorization.
- Ordering is best-effort globally. Where existing semantics require ordering
  for the same recipient and aggregate, projectors materialize by
  `(occurredAt, id)` and may defer a later row while an earlier non-terminal row
  remains. An unrelated poison event must not block other aggregates.

## Backward compatibility and rollout

- Add the new table/indexes first. The migration is additive and safe for old
  backend binaries.
- Deploy order remains backend-only; no app deployment is needed.
- During mixed backend versions, old producers may continue creating existing
  notification intents while new producers append domain events. Existing
  delivery keys must deduplicate both paths.
- New code reads all existing API fields defensively and does not remove or
  repurpose any endpoint, payload field, notification type, or table.
- Preserve the existing two production HTTP workers and existing cron owner.
  Projection runs as bounded work in the cron process; no new worker topology.
- Redis is never a cutover requirement.
- Pending old notification schedules drain by durable row state. Remove legacy
  production producer paths only when mixed-version processes cannot create
  more old-path work and the corresponding rows are terminal.
- No runtime release flag. Compatibility is additive and idempotency-key based.
- Production migration/deployment requires explicit in-the-moment approval.

## Implementation path

New durable-event code lives under `src/modules/domainEvents/`:

- `index.js` is the only cross-module import surface;
- `models/domainEventOutbox.js` owns Prisma persistence and raw claim queries;
- `commands/appendDomainEvent.js` owns create-or-confirm-identical append and
  occurrence-time audience writes;
- `queries/claimDomainEvents.js` and recipient claim queries own fenced reads;
- `services/notificationProjector.js` contains the versioned handler registry;
- `jobs/domainEventProjection.js` provides
  `buildDomainEventProjectionJob(dependencies = {})` and scheduling;
- `jobs/domainEventRetention.js` provides an injected, idempotent cleanup job;
- each command/query is in its own file and workers use `buildX(dependencies =
  {})` so integration tests inject clocks, repositories, and notification
  projection failures without module mocking.

Prisma access is confined to the model/repository layer. Domain modules import
only `appendDomainEvent` from `src/modules/domainEvents/index.js`; the domain-
events module may not import a domain command. Notification projectors may use
public domain queries for documented eligibility but may never write domain
state.

Extract support reply mutation from the thick admin route into
`src/modules/feedback/commands/sendStaffReply.js`. It accepts injected
dependencies and an optional transaction client; the route parses/authenticates,
invokes the command, and serializes only. The command atomically writes the
message/thread state and generic domain event, with no notification import.

Register projection and retention inside the existing `startCrons()` cron-role
branch. Projection inherits the established consolidated
`INBOX_DELIVERY_DISABLED` operational brake: when that existing brake is active,
domain writes continue and durable events accumulate for later recovery. No new
flag or process role is introduced. Retention follows the established
destructive-cleanup/job-run pattern and never runs in HTTP or resolution roles.

1. Add failing integration tests for notification-failure isolation on local
   event provisioning, local boundary activation, legacy global-event creation,
   and support replies.
2. Add failing crash-window/replay integration tests for representative social,
   race, powerup, tournament, reminder, and support producers.
3. Add the additive `DomainEventOutbox` migration and Prisma model.
4. Implement the minimal domain-event append/claim/lease/complete repository.
5. Implement resumable fan-out, recipient-scoped projection rows, the bounded
   notification projector, and recovery scans under the existing cron owner.
6. Add golden notification parity fixtures for every visible handler before
   migrating producers.
7. Migrate global-event paths first and prove notification failure cannot alter
   entitlement outcomes, impacts, recalculation enqueueing, live progress, or
   final settlement.
8. Migrate support replies and prove the message commits independently.
9. Migrate remaining producer families one owning transaction at a time:
   social, races, powerups, tournaments, rewards/referrals, then reminders and
   placement-derived events.
10. Move notification claims/cooldowns and recipient fan-out into projection;
    make domain-side observation claims atomic with domain-event append.
11. Remove visible notification reliance on `eventBus`; retain only explicitly
    non-durable internal hints.
12. Drain existing scheduled rows through their existing state machine and
    retain mixed-version deduplication.
13. Add structural guards prohibiting domain-module imports of notification,
    Inbox, provider, device-token, and notification-Redis implementation code.
14. Run the relevant integration suites against a confirmed local/test
    Postgres, then `npm run test:unit` and `npm run test:integration` as
    appropriate. Never run bare `npm test`.
15. Run code review, inspect migration/query plans, document operational
    counters and recovery procedures, and stop before deployment.

Initial safe operating bounds are 100 recipient expansions per transaction, 50
recipient projections per claim, four concurrent projection operations (with a
hard reviewed ceiling of 16), and a five-second projector tick budget before
yielding to other cron work.
Retries use bounded exponential backoff with jitter and a maximum of 12
attempts before `FAILED_TERMINAL`. These are code constants covered by tests,
not runtime release controls. Capacity tests must validate or lower them before
production deployment; increasing them later is a normal reviewed code change.
The production cron process currently shares a 20-connection database pool, so
16 is a ceiling, not a target. Capacity acceptance must record pool waiters,
pool wait duration/timeouts, projector latency, and latency of existing cron
jobs under representative largest fan-out. Release requires demonstrated pool
headroom; otherwise concurrency is lowered in code before deployment.

## Tests-first plan

### Integration tests

- Inject notification schedule, Inbox, projector, Redis, and provider failures
  independently and prove each domain transaction still commits.
- Local 2x activation creates impact and activated outcome when notification
  projection is unavailable; timestamped steps receive 2x in live and settled
  scoring after normal race recalculation.
- A failed gameplay activation produces no activation event and no
  notification.
- Legacy event creation succeeds for all participants when notification
  projection is unavailable.
- Support reply persists and remains readable when notification projection is
  unavailable.
- Process crash after domain commit but before projection is recovered from
  Postgres.
- Crash after Inbox/outbox creation but before event completion replays without
  duplicate visible alerts or outbox rows.
- One poison recipient does not block other recipients or later events.
- Large fan-out crashes between pages and resumes from its committed stable
  cursor without skipped or duplicate recipient projections.
- Mixed old/new producers deduplicate on the existing public delivery key.
- For every producer-matrix row, run the old handler and V1 projector against
  the same fixture and assert the literal canonical delivery key, title/body,
  Inbox destination, complete provider payload, audience, and suppression
  result are identical. Any intentional new key above has an explicit
  no-overlap assertion.
- Existing pending schedules drain without early, duplicate, or expired sends.
- Legacy global schedule scanning immediately before, concurrently with, and
  after activation proves `PENDING_ACTIVATION` is retried rather than cancelled
  and only committed impacts become `ELIGIBLE`.
- Mutating race/tournament membership after source commit does not add or omit
  occurrence-time recipients; only matrix-documented later suppression applies.
- Daily-mover tied candidates choose the same lowest-race-ID winner after a
  crash following a partial user batch; replay uses the same digest payload and
  cannot conflict or duplicate.
- Every visible producer has request/command/job-to-Inbox integration coverage;
  tests use public paths rather than importing internal notification helpers.
- Payload parity fixtures cover iOS and Android public fields and routes.
- Concurrent projector claims and expired-lease recovery are fenced.
- Redis absent/restarted and APNs/FCM failure do not lose domain events.
- Redis-backed integration coverage uses local Redis DB 15, and the relevant
  recovery suite also passes with `REDIS_URL` unset.

### Unit/structural tests

- Event-key canonicalization and create-or-confirm-identical behavior.
- Payload-size enforcement and stable audience ordinal/idempotency behavior.
- Lease fencing, backoff, terminal classification, and bounded batch behavior.
- Projection-kind immutability and crash replay route from the stored kind;
  silent transport keys are deterministic and never create Inbox rows.
- Projector handler registry rejects unknown schema versions without consuming
  the event.
- The checked-in producer matrix, visible-handler registry, projector registry,
  and golden payload fixtures have exact coverage parity.
- No visible provider send exists outside the Inbox delivery worker and its
  explicit test-only compatibility adapter.
- Domain modules cannot import notification delivery, Inbox creation, device
  tokens, APNs/FCM, or notification Redis code.
- No visible notification producer uses process-local `eventBus` as its only
  handoff.

Existing assertions may not be weakened, skipped, or deleted.

## Observability and operations

Record at minimum:

- pending events by type and oldest age;
- projection attempts, completions, retries, and terminal failures;
- lease reclaims and idempotent replay counts;
- time from `occurredAt` to Inbox/outbox materialization;
- suppression/no-recipient outcomes by reason;
- downstream schedule, Inbox outbox, and provider lag separately.

Initial service objectives are: normally eligible immediate events reach a
durable Inbox/outbox row within 10 seconds at p95 and 30 seconds at p99; alert
when the oldest eligible pending parent or recipient projection exceeds 60
seconds for five consecutive minutes, or immediately on any
`FAILED_TERMINAL`. Scheduled events measure from `availableAt`, not creation.
These are observability objectives, not domain gates: breaching them never
pauses gameplay or other domain schedulers.

Logs use event IDs/types and bounded error codes; they do not include device
tokens, support-message bodies, or unrestricted payload dumps. Health snapshots
must identify backlog without treating notification health as domain health or
blocking domain schedulers.

## Acceptance criteria

- Notification implementation failures cannot roll back or alter any gameplay,
  social, tournament, reward, referral, support, or account-domain state.
- 2x eligibility and scoring depend only on event/entitlement/impact timestamps
  and state, never notification schedule, Inbox, token, Redis, or provider state.
- Every visible notification has a durable post-commit source and deterministic
  delivery key; process-local callbacks are never the sole handoff.
- A failed domain operation cannot produce a visible notification claiming it
  succeeded.
- One notification event or recipient failure cannot block unrelated domain
  work or notification projection.
- Frozen iOS and Android clients receive unchanged public payloads and Inbox
  behavior.
- Pending old schedules drain safely during mixed backend versions.
- No new feature flag or production process is introduced.
- Migration is additive and safe during rolling deployment.
- Required tests pass against a confirmed non-production database.
- Failed-terminal rows are visible in operations metrics and replayable by
  explicit ID without changing their source domain records.
- Architect and code-reviewer reviews complete before the work is called done.
- No production or staging operation occurs without the required authorization.

## Open questions

None currently. The specification assumes the requested end state is all
visible notifications, not only the four confirmed rollback couplings, and
uses a generic durable domain-event outbox to achieve both isolation and crash
recovery.

## Revision log

- Initial draft: separated domain facts from notification projection, covered
  the four confirmed rollback couplings, replaced ephemeral visible-event
  handoff with a durable outbox, preserved existing Inbox/provider delivery,
  and defined compatibility, migration, test, and operational requirements.
- Gap pass 1: added resumable two-stage fan-out and recipient-scoped projection
  rows so poison recipients cannot block a parent event; strengthened the
  legacy global-event schedule drain to require committed gameplay activation.
- Gap pass 2: added payload data minimization, mechanical producer/handler
  coverage enforcement, explicit poison-event replay, scoped ordering rules,
  and conservative bounded projector capacity/retry defaults.
- Architect review: added tri-state legacy schedule eligibility, atomic
  occurrence-time audiences and a complete producer matrix, exact parent/
  audience/projection schemas and deletion semantics, preserved the existing
  C0 race-recalculation path, specified module/DI/cron placement and support
  command extraction, preserved Inbox creation without device tokens, made
  retention mandatory, and added pool-capacity and backlog objectives.
- Architect re-review: replaced delivery-key shorthands with literal mixed-
  version formulas and per-type parity tests, split race-message and placement
  visible versus silent-refresh projection, made daily-mover tie selection
  replay-stable, specified Redis DB 15/unset coverage, and lowered initial
  projection concurrency to four.
- Architect final correction: persisted immutable visible/silent projection
  kind with literal silent transport keys and aligned high-multiplier
  deduplication with the production race-resolution HMAC formula.
