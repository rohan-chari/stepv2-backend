# Redis efficiency writer census

Source census baseline: backend 7a4683c, September 10, 2026. This is a source-map aid for release-A invalidation coverage, not evidence that hooks have already been implemented. Every source writer must be reconciled with implementation and tested before release B. PostgreSQL transactions must commit before external cache invalidation; wrappers receiving tx must register/return affected identities to the owning transaction, not invalidate uncommitted state.

## Steps and milestone display

| Source | Mutation/ownership | Required cache identity |
|---|---|---|
| `src/modules/steps/models/steps.js:create/update` | Own Prisma transaction; daily step create/update plus scoring version. update can change fields including date; compare old/new user/date if allowed. | User/date milestones, existing daily cache; coalesce repeated dates |
| `src/modules/steps/services/stepInputIntake.js` | Raw `INSERT INTO steps ... ON CONFLICT` inside intake transaction, not Steps wrapper. StorageChanged/scoringChanged are distinct; daily display must follow persisted daily changes even if race scoring unchanged. | Every changed user/date once per committed intake batch |
| `src/modules/steps/commands/claimStepMilestone.js` | Direct claim insert then awardCoins; claim is persisted before award completes. Invalidating only after award risks stale claim when award fails. No cache may authorize/repeat award. | User/claimedDate after actual persisted claim |
| `src/modules/users/commands/deleteUserAccount.js` | Transaction deletes steps/claims and other user data. | User access revoked first; invalidate remaining user-specific fragments after commit |
| `scripts/seed-app-review-demo.sql`, `scripts/reset-app-review.sql` | Prod-capable direct SQL operational scripts, bypass model hooks. | Operational JS wrappers must collect affected actors/date scopes and await cache invalidation or require explicit authoritative-version mechanism; documentation-only advice does not make recurring tools safe |

## Race slots, boxes and queued inventory

| Source | Mutation/ownership | Required cache identity |
|---|---|---|
| `src/modules/powerups/models/racePowerup.js:create/update/claimForDiscard/expireAllForRace` | Direct model writes, some accept caller tx. Updating ownership needs old and new participant identity. expireAllForRace is race-wide. | Participant inventory token for direct changes; race inventory epoch can invalidate whole race in O(1), never N new SQL reads |
| Same model `stealRandomHeldPowerup` | Own transaction moves participantId/userId from victim to recipient. | BOTH source and destination inventory tokens post-commit |
| `src/modules/powerups/commands/usePowerup.js` | Multiple direct ORM updateMany paths: discard/consume/claim; may move or steal target holdings. | Actor and all actually affected participants, captured from existing transaction result |
| `src/modules/powerups/commands/rollPowerup.js` | Direct createMany/create in transactions; worker box mint and queue placement. | Batched changed participant tokens after commit |
| `src/modules/powerups/commands/rerollMysteryBox.js`, `rerollMysteryBoxBatch.js` | Direct tx updateMany, not model update. | Participant once per transaction/batch |
| `src/modules/billing/commands/rerollPurchase.js` | Direct billing tx updateMany modifies slot type/rarity. | Participant after billing transaction commit, including idempotent replay paths that must not add unnecessary work |
| `src/modules/powerups/commands/openMysteryBox.js`, `openMysteryBoxBatch.js`, `redeemPowerupToRace.js`, `discardPowerup.js`, upgrade paths | Model and/or transaction mutation callers; trace caller tx boundary and existing invalidators. | Actor participant and any recipient/target whose slots change |
| `src/modules/races/services/racePowerupStateSync.js` | Direct tx updateMany queue promotion; invoked by worker/legacy reconciliation. | Changed participant post-commit |
| `src/modules/races/services/racePowerupInventoryRepair.js` | Queued-to-mystery status via model update; potentially multiple rows per participant. | One coalesced participant invalidation where transaction ownership permits; all committed rows reflected |
| `src/modules/races/services/seededChallengeWelcome.js` | Receives caller tx, createMany initial boxes. | Collect affected participants for owning commit |
| `src/modules/races/commands/joinRaceCore.js`, `autoEnrollNewUser.js` | Direct tx create initial box. | New participant slots and race membership counts/invite metadata |
| Operational review SQL scripts | Direct insert/delete bypass JS cache domains. | Same operational wrapper/version requirement as above |

Slot cache payload must preserve selected consumer fields/order and not cache consumable recent-mint notices. A globally unique participant key still requires current access verification. Field narrowing must not drop flags subsequently read by callers of the existing model method.

## Race display event eligibility

| Source | Mutation/ownership | Required cache identity |
|---|---|---|
| `src/modules/steps/services/globalStepEventEntitlement.js:materializePreparedEntitlementsSetBased` | Raw entitlement insert in caller tx | User entitlement token; existing batch identities returned to transaction owner |
| `ensureEntitlementForUser` | Caller tx upsert | User entitlement token |
| `materializeEntitlementsForActiveRacers` | Own transactions/batches, createMany + legacy individual writes | Bounded coalesced user tokens or shared event epoch |
| `processDueEntitlementBoundaries` | Per-cohort tx updateMany; already post-process Home invalidation | Reuse transitioned-user batch to include new display event domain |
| `processDueStartMicroBatch`, `processDueEndMicroBatch` | Own transactions, updates eligibility/outcomes | Return/retain affected IDs for awaited outer-drain invalidation |
| `ensureRaceGlobalEventEligibility` | Own transaction, eligibility mutations on reads/worker paths | User+race or shared event/user tokens after commit |
| `src/modules/steps/jobs/globalEventBoundaryDrain.js` | Wrapper plus retry/singleton failure updates | Existing final `invalidateHomeActiveGlobalEvent(transitioned)` must cover new domains; failure/outcome transitions considered |
| `src/modules/steps/jobs/globalEventEndDrain.js` | Wrapper plus raw failure-state SQL | Existing finally invalidation batches users; extend to new display domain |
| `src/modules/steps/services/globalEventEnrollment.js:enrollIfGlobalEventActive` | Caller tx modifies event enrollment/entitlement | Owning transaction advances affected user/event/race identities |
| `src/modules/steps/services/globalEventTimezoneReconciliation.js` | Raw entitlement relocation in own tx; current final hook only timezoneStateCache | A committed timezone move must invalidate all affected viewer event variants via common token; no timezone-key enumeration |
| `src/modules/steps/services/globalStepEventRetention.js` | Own transaction deletes expired entitlements | Already expired rows cannot serve active display past absolute end; prove this instead of high-volume per-row invalidation where safe |
| Global event model create/update/cancel/admin paths | Changes schedule or event state while cached eligibility might still exist | Event/global schedule token + absolute next transition validity |
| User account deletion | Deletes entitlement rows transactionally | Authoritative auth blocks old user; user-domain invalidation after commit |

Negative race-event results may be cached only with known next eligibility/time boundary or explicit invalidation coverage. Home's user-only key cannot answer a race-scoped query. Timezone relocation may need invalidating both old and new eligible event identities; user token covers all request variants.

## Test-only sources and exclusions

`src/modules/loadTesting/*`, `scripts/perf/*` and `scripts/diagnostics/*` contain direct fixture writes. They are not production application writers when their local/disposable guards are enforced. Every measurement must reset or appropriately invalidate its own isolated Redis before measuring fixture state; otherwise it can produce a falsely warm or stale candidate. Do not introduce cache mutations into prod as a way of verifying these fixtures.

Source search covered direct ORM writes and SQL DML strings under src/scripts for steps, step_milestone_claims, race_powerups and global_step_event_entitlements. It does not itself prove generated SQL, delete cascades, indirect model callers or administrative scripts have complete hooks. Final implementation audit must enumerate covered seams and link their HTTP/worker integration evidence.
