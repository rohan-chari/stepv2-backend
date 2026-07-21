# Backend Architecture Audit

Read-only analysis of `src/` as of commit `534a6b8` (2026-07-21).

> **Status update (2026-07-21):** Phase 1 of the migration plan (shared errors + central error middleware, §6) has been implemented — see [Phase 1 implementation status](#phase-1-implementation-status-2026-07-21) at the bottom for what landed, verification results, and the things later phases must be aware of. The rest of this document still describes the pre-Phase-1 state.

**Scale:** ~262 JS files, ~37,500 lines across 14 top-level folders. Stack: Express + Prisma (`@prisma/adapter-pg`), CommonJS, entry `src/index.js` → `src/app.js`.

---

## Summary table (highest-priority findings)

| File | Issue type | Severity |
|---|---|---|
| `src/commands/usePowerup.js` | Monolith: 1,935 lines, 55 throw sites in one command | High |
| `src/queries/getRaceProgress.js` | Query that performs writes; circular import with `raceStateResolution`; cross-domain (races/steps/tournaments/powerups) | High |
| `src/services/raceStateResolution.js` | 829-line grab-bag service (pure math + DB + orchestration); circular with `getRaceProgress` | High |
| `src/routes/admin.js` | Direct `prisma.*` in 5 handlers; 90-line validation/merge engine inline; ORM error codes (P2025) in route | High |
| `src/commands/completeRace.js` | Race settlement directly drives tournament brackets via raw `db.tournamentParticipant` access | High |
| `src/handlers/notificationHandlers.js` | Handler with raw `prisma` fallbacks, notification business rules, duplicated APNs/FCM dispatch | High |
| `src/app.js` | No central error middleware; two full landing-page handlers + inline DB write + inline middleware in app assembly | High |
| Error handling (app-wide) | ~39 bespoke error classes carrying HTTP `statusCode` in commands/queries/services/utils; ~40 copy-pasted route mapping blocks *(Phase 1 built the shared `AppError` + central middleware; route/class migration is Phase 2)* | High |
| Validation (app-wide) | 100% ad-hoc `if` checks; no schema library anywhere | High |
| `src/routes/steps.js` | Full stats/streak/averages aggregation inline in `GET /stats` (lines 192–280) | Med |
| Tournament services (`tournamentAccess`, `tournamentRounds`, `tournamentStart`, `tournamentParticipants`, `tournamentLock`) | Entire domain bypasses `models/` — services run Prisma directly | Med |
| `src/commands/purchasePowerupItem.js`, `purchaseShopItem.js` | Full model bypass; ~~re-inline the atomic coin-debit that `deductCoinsAtomic.js` already provides~~ *(debit unified in Phase 3; model bypass remains)* | Med |
| `src/models/raceResolutionJob.js` | Retry/lease/generation workflow engine + client serialization inside a "model" | Med |
| `src/jobs/seededRaceRenewal.js`, `tournamentSeedRenewal.js`, `placementRecompute.js` | Jobs doing inline Prisma CRUD + business logic instead of delegating to commands | Med |
| `src/utils/powerupOdds.js`, `dailyBoxOdds.js`, `powerupUpgrades.js` | utils → services dependency inversion (import `services/balanceConfig`) | Med |
| `src/utils/clientFeatures.js`, `releaseChannel.js` | Express middleware living in `utils/` | Med |
| `src/routes/onboarding.js` | Direct `prisma.*` + coin-eligibility rules inline in a 95-line route file | Med |
| `src/routes/auth.js` | 5 direct model calls in handlers; ~~latent `ReferenceError` on un-imported `DisplayNameTakenError` (line 360); `GET /me` returns 200 on error~~ *(both fixed in Phase 1)* | Med |
| `src/queries/serializeTournament.js` | Pure serializer misfiled in `queries/`, imported by 8 commands | Med |
| `src/routes/home.js`, `analytics.js`, `tutorial.js`, `notifications.js` | Orchestration / direct DB / direct-model access in handlers | Med |
| Race↔tournament parallel files (`*BuyIns`, `*Lock`, `leave/forfeit/kick/cancel/invite/shareLink` pairs) | Structural copy-paste, separately maintained | Med |
| `src/commands/registerUser.js`, `src/middleware/requireAppleAuth.js`, `src/queries/getUser.js`, `src/models/tournamentParticipant.js`, `src/models/tournamentSeed.js` | Dead files — zero inbound requires | Low |
| `src/services/streakTracking.js`, `src/utils/rankings.js` | Production-dead, referenced only by their own tests (superseded implementations) | Low |
| `src/utils/recordLeaderboardRankings.js` | Legacy `*Challenge*` export cluster from removed feature, test-only reachable | Low |
| `src/routes/shop.js` | Redundantly re-applies `extractClientFeatures` already stamped globally in `app.js:89` | Low |

---

## 1. Current structure overview

```
src/
├── app.js          (293)  Express assembly + inline landing pages, static, deep links
├── index.js        (167)  Bootstrap + all cron/job scheduling + kill-switch env logic
├── db.js            (34)  PrismaClient singleton (pg adapter)
├── peerDb.js        (48)  Optional peer-DB Prisma (staging↔prod shop-item mirroring)
├── routes/      21 files, 4,412 lines  Express routers, one per surface
├── commands/    73 files, 10,571 lines  Write use-cases (one file per action)
├── queries/     38 files, 5,578 lines  Read use-cases (one file per read)
├── models/      25 files, 2,735 lines  Prisma table wrappers
├── services/    34 files, 5,298 lines  Grab-bag: pure validators, DB transactions,
│                                       compute engines, external IO (APNs/FCM/storage)
├── utils/       25 files, 2,674 lines  Mostly pure helpers — but also middleware,
│                                       economy math, and a cross-DB mirroring writer
├── jobs/        13 files, 2,343 lines  Cron bodies (setInterval from index.js)
├── handlers/     2 files, 1,373 lines  eventBus subscribers (logging + push dispatch)
├── constants/   11 files, 1,158 lines  Pure data (clean)
├── middleware/   4 files,   254 lines  Auth (Apple/session/admin) + timezone extraction
├── web/          4 files,   577 lines  Server-rendered landing pages / deep-link files
├── config/       4 files,   219 lines  Env-derived config (clean)
├── lib/          3 files,   154 lines  Pure helpers (displayName, profanity, referral code)
└── events/       1 file,     17 lines  Synchronous in-memory pub/sub
```

### The de-facto architecture

The nominal layering is **routes → commands/queries → models (Prisma)**, with `services/` and `utils/` as support. In practice, no layering is enforced:

- **`models/`** is optional. 41/73 commands and 15/38 queries import `db.js`/Prisma directly; 26 commands use no model at all. The tournament domain bypasses models entirely (its "models" `tournamentParticipant.js`/`tournamentSeed.js` are dead files — see §5).
- **`services/`** means nothing consistent: pure functions (`adminAccess`, `raceBuyIns`, `tournamentErrors`), 800-line compute engines (`raceStateResolution`), DB transaction owners (`tournamentLock`, `balanceConfig`), and external IO clients (`apns`, `fcm`, `profilePhotoStorage`) all live side by side.
- **`utils/`** contains Express middleware (`clientFeatures.js:20-23`, `releaseChannel.js:26-29`), service-tier economy logic (`dailyBoxOdds`, `powerupOdds`, `hitchhikeCopies`, `leechTransfers`, `powerupUpgrades`), and a cross-DB writer (`mirrorShopItem.js`).
- **`lib/` and `constants/`** are the only folders whose contents fully match their names.

### Naming/organization inconsistencies

- Route logic split: most handlers live in `routes/`, but `app.js:150-251` defines two full landing-page handlers (`/r/:token`, `/t/:token`) plus `/health`, `.well-known`, and static routes inline, and `app.js:67-77` defines middleware inline.
- `queries/serializeTournament.js` is a serializer, not a query; `queries/getEligiblePowerupPool.js` and `getUnownedAccessoryPool.js` are internal helpers for daily-reward **commands**, not endpoint queries.
- Several "commands" are internal shared utilities, not entry points: `awardCoins`, `deductCoinsAtomic`, `expireEffects`, `grantReferralReward`, `joinRaceCore`/`joinTournamentCore` (the `*Core` suffix concedes it).
- Cron wiring + per-job env kill-switch logic lives in the bootstrap (`index.js:63-127`) rather than a job registry; `index.js:153` even `require`s a dev script inside a SIGINT handler.

---

## 2. Layer violations

### 2a. Database access in route handlers

| File | Lines | What's mixed | Should move to |
|---|---|---|---|
| `src/routes/admin.js` | 170-172, 194-197, 237-240, 276-278, 327-330 | `prisma.shopItem` / `prisma.powerupShopItem` findMany/findUnique/update inline | Model (`shopItem`, `powerupShopItem`) or admin commands |
| `src/routes/admin.js` | 256-258, 344-346 | Prisma `P2025` error-code handling in route | Model/command layer |
| `src/routes/onboarding.js` | 11-26, 41-48 | `prisma.raceParticipant.findFirst`, `prisma.coinTransaction.findFirst` inline | Query (`getStarterRewardStatus`) |
| `src/routes/analytics.js` | 155-158 | `prisma.activationEvent.createMany` in handler | Model/command |
| `src/app.js` | 144-148 | `linkOpenDb.linkOpen.create(...)` in `logLinkOpen` | Model/command |
| `src/routes/races.js` | 839-888, 896-937 | Direct `raceModel`/`effectModel`/`powerupModel` reads + filtering for sneaky-swap options/targets | Queries (`getSneakySwapOptions/Targets`) |
| `src/routes/auth.js` | 228-243, 381, 405, 538 | `UserModel` find/create/update inline (incl. reviewer auto-provision branching) | Commands |
| `src/routes/steps.js` | 154-156, 252 | `raceResolutionJobModel.findById` + `SeasonScore.getActiveForUser` inline | Query |
| `src/routes/notifications.js` | 22, 40, 50, 73, 95 | Every handler calls `User`/`DeviceToken` models directly — no use-case layer | Commands/queries |
| `src/routes/tutorial.js` | 41, 58 | `userModel.update` inline | Command |

### 2b. Business logic in controllers

| File | Lines | Logic | Should move to |
|---|---|---|---|
| `src/routes/steps.js` | 192-280 | Full stats aggregation: week/month/year/all-time, per-day averages, streak computation, `COMPAT_STEP_GOAL` backfill | Query (`getStepStats`) |
| `src/routes/admin.js` | 19-108, 201-204 | `sanitizeRenderMetadata`/`persistentRenderMetadata` — per-animal override merging, coercion, enum checks | Service |
| `src/routes/home.js` | 33-125 | 90-line aggregation orchestrator: stitches home card + global event + milestones + daily-reward derivation + ad-spin status behind 4 nested try/catch | Query/home service |
| `src/app.js` | 150-217 | Referral-vs-race token disambiguation, Play Store referrer URL baking | `routes/web` + service |
| `src/routes/races.js` | 108-112, 486-502 | `isStealable` rule at module scope; post-response fire-and-forget rival step-sync orchestration | Query / service |
| `src/routes/onboarding.js` | 50-56, 66-72 | Starter-reward eligibility + claim-guard rules | Command/query |
| `src/routes/dailyReward.js` | 77-96 | Conditional status augmentation (ad spin / ad coin reward) in handler | Query |
| `src/routes/auth.js` | 81-114 | `withRuntimeFlags` + `getHeldCoinsSafe` composition helpers | Service |
| `src/index.js` | 80-119 | Per-job env kill-switch decisions in bootstrap | Jobs scheduler registry |

### 2c. HTTP concerns leaking into non-HTTP layers

No command/query/service/model touches `req`/`res` directly (the only `req.` in non-route code is the two middleware-in-utils files). The leakage is via **error objects carrying HTTP status codes**, and it is pervasive:

- **41 command/query files** set `statusCode` on thrown errors; ~39 bespoke `XxxError extends Error` classes, most re-declared per file (`RaceJoinError` `joinRaceCore.js:26-35`, `PowerupPurchaseError` `purchasePowerupItem.js:5-11`, `RaceCreationError`, `RaceEditError`, …). Tournaments are the only domain with a shared class (`services/tournamentErrors.js:4-11`).
- **Queries throw HTTP 404s**: `getRaceProgress`, `getRaceDetails`, `getRaceFeed`, `getRaceInventory`, `getRaceMessages`, `getDailyRewardStatus`; `getStepMilestonesToday` throws 400.
- **Services/utils**: `balanceConfig.js:28-33,95,645`, `raceBuyIns.js:24-37` (hardcodes 400 inside pure validation, via an injected `ErrorClass` param), `appSettings.js:95`, `utils/stepSyncCanonical.js:22-28`.
- Inconsistent shape: some classes default `statusCode = 400`, some set it conditionally, some add a machine `code`, most don't; `deductCoinsAtomic.js` and `getOrCreateReferralCode.js` throw bare `Error` with no status at all.

*Recommendation direction:* one shared `AppError` (message, machine code, severity) + a single route-layer mapper from machine code → HTTP status.

### 2d. Validation scattered ad hoc

There is **no schema library** (no zod/joi/express-validator in `package.json`). Every route validates with inline `if` checks. The only hand-rolled "engines" are `analytics.js:45-135` (regex allow-lists, enum sets, timestamp-skew window) and `admin.js:19-108`. Reusable validators exist only for narrow cases (`lib/displayNameValidator`, `utils/admobSsv`, `services/validateRaceConfig`). Pagination parsing alone appears in three ad-hoc variants (`races.js:827`, `races.js:943`, `admin.js:381`).

---

## 3. Cross-module coupling

### Direct cross-domain reach-through

- **`commands/completeRace.js` (races → tournaments)** — imports `advanceTournament` (:21-23) and `resolveMatchupWinner` (:20), and reaches into `db.tournamentParticipant.findMany/update` raw (:79-126). Race settlement directly drives bracket advancement.
- **`queries/getRaceProgress.js` (query → commands + steps + tournaments)** — imports the `completeRace` and `expireEffects` **commands** (:7-8) — a read that mutates — plus `Steps`/`StepSample`/`GlobalStepEvent` models (:3-5,22) and `services/tournamentAccess` (:34).
- **`commands/forfeitRace.js` (races → steps)** — imports three step-domain models (:5-7) plus leech/hitchhike utils; also `$queryRawUnsafe` at :202.
- **`queries/getTournamentsForUser.js` (tournaments → race models)** — imports `RacePowerup`, `RaceActiveEffect` (:3-4).
- **8 tournament commands → `queries/serializeTournament`** — commands importing a query-folder serializer.
- **Daily-reward cluster** — `claimDailyReward*` commands import `queries/getUnownedAccessoryPool`, `getEligiblePowerupPool`, `getDailyRewardStatus`, tangling coins/powerups/cosmetics.
- **Tournament services → race services** — ~~`tournamentBuyIns.js:7` imports `ensureUserCanAfford` from `raceBuyIns`~~ *(resolved in Phase 5: both now import from `shared/economy/buyIns`)*; `tournamentRounds.js:1` still imports `snapshotBaselineFields` from `raceBaseline` (deliberate reuse, but couples the domains through internals rather than a shared module).
- **utils → services inversion** — `utils/powerupOdds.js:10-11`, `utils/dailyBoxOdds.js:10-11`, `utils/powerupUpgrades.js:1` import `services/balanceConfig` (stateful, DB-backed). One import in the other direction away from a cycle.
- **models → utils** — `models/powerupShopItem.js:2` imports `utils/releaseChannel` for filtering rules.
- **`handlers/notificationHandlers.js`** — imports models, both push services, *and* `../db` directly, using `prisma.raceParticipant`/`prisma.race` as fallback models (:17-18).

### Circular imports

- **Confirmed cycle:** `queries/getRaceProgress.js:10` imports `services/raceStateResolution`, while `services/raceStateResolution.js:8` imports `computeEffectModifiers` back from `getRaceProgress`. `getRaceProgress.js:818` also lazy-`require`s `calculateBaseAdjusted` mid-function — the classic cycle-dodging workaround.
- **Near-cycle web:** `services/racePowerupStateSync.js:4` imports the `rollPowerup` command; that service is imported by `getRaceProgress`, `recordStepSamples`, and `discardPowerup` — commands and a query depending on a service that depends on a command.
- `getRaceProgress → completeRace → advanceTournament` is not a closed cycle but is a query invoking a cross-domain write chain.

---

## 4. Inconsistent patterns

### Async styles — the clean spot

Uniformly `async/await`. The only `.then`/`.catch` sites are deliberate fire-and-forget (`races.js:496-501`, `friends.js:82-87`, `recordSteps.js:139-147`, `recordStepSamples.js:141-149`, `getPowerupShopCatalog.js:40`, `app.js:145-147`) and raw-Promise wrappers around IO (`apns.js`, `admobSsv.js`, lock helpers). No callback-style code anywhere.

### Error handling — inconsistent

- **No central error middleware.** `app.js:259-270` handles only body-parser 413s; there is no 4-arg catch-all. `next(err)` is essentially unused — every handler hand-rolls `try/catch + res.status(500)`, so a forgotten try/catch becomes an unhandled rejection.
- The `if (error.name === "XxxError") return res.status(error.statusCode||400).json(...)` block is copy-pasted **~40 times** across route files. `tournaments.js:34-43` (`sendError`) is the only file that factored it out.
- Outliers: `auth.js` `GET /me` swallows errors and returns **200** with a degraded user (:288-291); `auth.js:360` references `DisplayNameTakenError` without importing it — a latent `ReferenceError` if that branch is reached.
- At least 7 distinct service-layer error classes with three different ways of attaching a machine code (`.code` string, constructor arg, none), no shared base.

### Duplicated logic

| Duplicate | Sites | Extract to |
|---|---|---|
| ~~Atomic coin debit (`updateMany` guard + ledger insert)~~ *(unified in Phase 3)* | ~~Canonical `deductCoinsAtomic.js:32-44` re-inlined in `purchasePowerupItem.js:91-119`, `purchaseShopItem.js:124-137`~~; `awardCoins.js:28-38` is a deliberate separate credit path (see Phase 3 notes) | Single coin-ledger service |
| Route error-mapping block | ~40 sites across routes | Shared `sendError` / central middleware |
| Race↔tournament command pairs (leave/forfeit/kick/cancel/invite/shareLink) | 6 pairs, each repeating not-found→404, membership→403, refund, emit | Shared competition-lifecycle helpers |
| ~~Advisory-lock idiom (`pg_advisory_xact_lock(hashtext(id))`)~~ *(extracted in Phase 4)* | ~~`raceJoinLock.js:3-8` vs `tournamentLock.js:11-18`~~ → both now wrap `shared/db/withAdvisoryLock.js` | `withAdvisoryLock(id, fn)` |
| ~~Buy-in reserve/refund/payout~~ *(unified in Phase 5)* | ~~`raceBuyIns.js:66-103` vs `tournamentBuyIns.js:13-55`~~ → both are thin wrappers over `shared/economy/buyIns.js` | Shared buy-in module |
| Stealth mask (`isStealthed ? "???" : displayName`) + participant shaping | `getHomeRaceCard.js:608` vs `getRaceProgress.js:971,987` | Shared participant serializer |
| APNs/FCM platform dispatch (`platform === "android" ? fcm : apns`) | `stepSyncPush.js:59-64` and `notificationHandlers.js` | One `sendPushToUser` primitive |
| `req.clientFeatures?.has("characters")` | races, friends, home, leaderboard, ranked, tournaments, shop (only `tournaments.js:67` wraps it) | Shared helper/middleware |
| Fire-and-forget step-sync push block | `races.js:491-502` = `friends.js:81-88` | Shared helper |
| Onboarding-seen `userModel.update` | `races.js:439`, `tutorial.js:41,58`, `auth.js:381,405` | Command |
| `status === "ACCEPTED"` participant filter | ~15 files (`completeRace.js:77,137,303`, `redeemPowerupToRace.js:38`, `editRace.js:108`, …) | Model helper |
| Pagination parsing | `races.js:827`, `races.js:943`, `admin.js:381` | Shared util |

### Job-layer split personality

Roughly half of `jobs/` delegate cleanly to commands (`autoStartScheduledRaces`, `raceResolutionQueue`, `computeRanks`); the other half run inline Prisma CRUD + business logic (`seededRaceRenewal.js` — 8 db-ops + own window math; `tournamentSeedRenewal.js:30-122` — 7+ direct db-ops; `placementRecompute.js` — 4 db-ops).

---

## 5. Dead code / orphans

> **✅ Removed (2026-07-21):** the five true orphans, both production-dead test-only files (+ their tests), and the `*Challenge*` export cluster in `recordLeaderboardRankings.js` (file kept; 6 dead exports + 3 dead tests stripped) are deleted — 706 lines total. Inbound requires were re-verified at deletion time (all still zero outside own tests). `getRanked.js`, `peerDb.js`, `balanceSnapshot.js` (script-only), and the `build*` DI factories were left untouched as documented below. Suites after removal: unit 1814/0 (−16 tests, all from the deleted test files, zero failures), integration 587 / 571 / 16 — unchanged.

Static analysis is reliable here: there are **no dynamic requires** in `src/` or `scripts/`, all routers are mounted in `app.js`, all jobs scheduled from `index.js`.

### True orphans (zero inbound requires — high confidence, removable)

| File | Contents |
|---|---|
| `src/commands/registerUser.js` | Thin wrapper over `ensureAppleUser`; superseded by direct usage |
| `src/middleware/requireAppleAuth.js` | Apple-auth middleware factory; superseded by `middleware/requireAuth.js` |
| `src/queries/getUser.js` | `getUserById`/`getUserByAppleId`, never imported |
| `src/models/tournamentParticipant.js` | Model wrapper class; all callers use the raw Prisma delegate |
| `src/models/tournamentSeed.js` | Same — raw delegate used everywhere |

### Production-dead, referenced only by their own tests (superseded implementations)

- `src/services/streakTracking.js` — live streak logic is `src/utils/streak.js` (used by `routes/steps.js`).
- `src/utils/rankings.js` — live ranking is `utils/recordLeaderboardRankings.js` / `services/rankedStandings.js`.

### Script-only (alive, but not part of the running server)

- `src/services/balanceSnapshot.js` — used only by `scripts/balance-*.js` / `generate-powerups-md.js`.

### Legacy export cluster

- `src/utils/recordLeaderboardRankings.js` — the `*Challenge*` exports (`buildChallengeRecordLeaderboard`, `challengeComparator`, `rankChallengeRecordEntries`, etc.) survive only for their test; the challenge feature was dropped (migration `20260317180000_drop_challenge_streaks`). `getLeaderboard.js` imports only `buildRaceRecordLeaderboard`.

### Verified NOT dead (do not remove)

- `queries/getRanked.js` — intentionally-retained legacy endpoint (`routes/ranked.js:57-69`) serving shipped app binaries < 1.3.0. **Keeping it is required by the repo's compat rule.**
- `src/peerDb.js` — alive via `admin.js → utils/mirrorShopItem.js → peerDb.js` (no-ops when `PEER_DATABASE_URL` unset).
- The many exported-but-unimported `build*` factories — deliberate dependency-injection pattern for tests; the default instance is consumed internally.

---

## 6. Suggested target structure

Module-per-domain, each domain exposing a small public interface (`index.js`) that other domains must go through. **Not implemented — proposal only.**

```
src/
├── app.js / index.js          # assembly + bootstrap only (no handlers, no cron logic)
├── shared/
│   ├── db/                    # db.js, peerDb.js, withAdvisoryLock, transaction helpers
│   ├── errors/                # AppError base + machine-code → HTTP status mapper
│   ├── http/                  # asyncHandler wrapper, central error middleware,
│   │                          #   validation helper (schema lib), pagination parsing
│   ├── middleware/            # requireAuth, requireAdmin, extractTimezone,
│   │                          #   clientFeatures, releaseChannel  (moved out of utils/)
│   ├── push/                  # apns + fcm + single sendPushToUser dispatch primitive
│   ├── events/                # eventBus (with per-handler error isolation)
│   ├── time/                  # week.js, etSchedule.js, raceTimeZone.js
│   └── lib/                   # profanity, displayNameValidator, referralCode, shareToken
├── modules/
│   ├── users/                 # auth routes, ensureAppleUser/ensureGoogleUser, profile,
│   │   │                      #   sessionToken, deleteUserAccount, notifications prefs,
│   │   └── ...                #   deviceToken repo
│   ├── steps/                 # steps routes, recordSteps/recordStepSyncV2, stepSample
│   │                          #   repos, stats query (moved out of routes/steps.js),
│   │                          #   streak, stepSyncCanonical
│   ├── races/                 # race routes, join/leave/forfeit/complete commands,
│   │                          #   getRaceProgress (read-only — resolution triggers move
│   │                          #   to a raceResolution service), raceStateResolution
│   │                          #   split into pure scoring/ vs orchestration/
│   ├── tournaments/           # tournament routes/commands/services + REAL repos
│   │                          #   (today the domain has no live model layer at all);
│   │                          #   serializeTournament.js lands here as a serializer
│   ├── competition-core/      # shared race/tournament lifecycle: buy-ins,
│   │                          #   join locks, kick/cancel/invite/share-link logic,
│   │                          #   baseline snapshots  (kills the 6 copy-paste pairs)
│   ├── powerups/              # shop catalog, purchase/use/roll/discard, odds +
│   │                          #   upgrades math (moved from utils/), effects
│   ├── economy/               # ONE coin ledger service (awardCoins +
│   │                          #   deductCoinsAtomic, no re-inlining), balanceConfig,
│   │                          #   daily reward + boxes, ad rewards
│   ├── cosmetics/             # shop items, equip, renderMetadata sanitizer (from
│   │                          #   routes/admin.js), mirrorShopItem
│   ├── social/                # friends, referrals, race chat, taunts
│   ├── ranked/                # ranked v1/v2 queries, cohorts, standings, seasons
│   ├── leaderboard/           # getLeaderboard + recordLeaderboardRankings (pruned)
│   ├── home/                  # getHomeRaceCard + the aggregation now in routes/home.js
│   ├── analytics/             # activation events + admin stats (raw SQL isolated here)
│   ├── admin/                 # admin routes, delegating into each module's service
│   └── web/                   # landing pages, deep links, /r /t handlers (from app.js)
├── jobs/                      # thin cron bodies ONLY — each delegates to a module
│   └── scheduler.js           # registry + env kill-switch logic (from index.js)
└── constants/                 # unchanged (already clean)
```

Per-module internal shape: `routes.js` (HTTP only: parse → validate via schema → call service → map errors), `service.js` (business rules, throws `AppError` with machine codes, no HTTP), `repository.js` (all Prisma for the domain's tables), `serializers.js`, `index.js` (public interface — the only thing other modules may import).

**Rationale highlights**

- `competition-core/` directly attacks the largest duplication cluster (6 race/tournament command pairs + locks + buy-ins) instead of leaving two parallel implementations to drift.
- `economy/` makes the coin ledger single-sourced — today three files re-implement the atomic debit, which is a correctness risk, not just style.
- A shared `errors/` + central error middleware eliminates both the ~40 copy-pasted mapping blocks and the HTTP-status leakage into 41 domain files, and fixes the "forgotten try/catch = unhandled rejection" hazard.
- Splitting `raceStateResolution` into pure scoring vs orchestration breaks the confirmed `getRaceProgress ⇄ raceStateResolution` cycle naturally (the pure math has no reason to import a query).
- Migration can be incremental and compat-safe: it's all internal file moves — **no API shape changes** — so it never violates the frozen-old-client rule. Suggested order: (1) shared/errors + central middleware **(✅ done — see below)**, (2) economy ledger unification **(✅ debit side done as Phase 3 — see below)**, (3) competition-core extraction, (4) module-by-module moves, (5) dead-file deletion from §5.

---

## Phase 1 implementation status (2026-07-21)

Implemented on top of `534a6b8` (uncommitted at time of writing). Scope was deliberately narrow: build the shared error infrastructure and wire it in — **no existing bespoke error class or route try/catch was migrated** (that is Phase 2).

### What landed

| File | What it is |
|---|---|
| `src/shared/errors/AppError.js` | `AppError(message, code, statusCode, meta)` base class + `NotFoundError` (404), `ValidationError` (400), `ForbiddenError` (403), `ConflictError` (409) |
| `src/shared/http/errorMiddleware.js` | Central 4-arg handler, mounted **last** in `app.js`. `AppError` → its status + `{ error, code, ...meta }`; legacy errors already carrying a valid 4xx/5xx `statusCode`/`status` keep that status with `{ error, code? }`; everything else → logged + opaque `500 { error: "Internal server error" }`. Respects `res.headersSent`. |
| `src/shared/http/asyncHandler.js` | Wrapper so async route handlers route thrown errors to `next(err)` instead of needing per-route try/catch |
| `src/app.js` | Mounts `errorMiddleware` after all routers/static routes; the pre-existing 413 body-parser handler is untouched and still runs first |
| `test/http/errorMiddleware.test.js` | Real-HTTP tests (same style as the rest of `test/http/`): all four subclasses, `meta` passthrough, legacy-statusCode mapping, opaque-500 fallback |
| `src/routes/auth.js` | Two standalone bug fixes: `GET /auth/me` now returns 500 on internal error instead of 200 with a degraded user; the null-display-name branch checks `error.name === "DisplayNameTakenError"` instead of `instanceof` on a never-imported class (was a latent `ReferenceError`) |

### Verification

- Unit suite: 1828 → **1830 pass, 0 fail** (+2 = the new tests).
- Integration suite: **556 pass / 16 fail both before and after**, failing list byte-identical — all 16 are the known pre-existing clusters (13 fanny-pack, 1 ad-coin-reward gating, 2 hitchhike/quick-rinse settlement). **No regressions introduced.**

### Things to be aware of going forward

1. **Behavior change — malformed JSON bodies.** Non-413 body-parser errors (e.g. invalid JSON → `entity.parse.failed`, status 400) previously fell through to Express's default **HTML** error page; the central middleware's legacy-statusCode branch now answers them with **JSON** at the same status code. Same status, different body shape. No test depended on the HTML shape, and JSON is the intended direction, but if a client ever parsed that HTML this is where it changed.
2. **Behavior change — `GET /auth/me` on internal error.** Old behavior silently returned 200 with a partial user; shipped app binaries have therefore never seen a 500 from `/auth/me`. ✅ **Resolved — verified safe (2026-07-21):** the Flutter client was traced end-to-end (see [Client investigation](#client-investigation-auth-me-5xx-on-shipped-builds-2026-07-21) below); shipped builds swallow any `/auth/me` error and keep the cached user. No version gating needed.
3. **The legacy-statusCode branch is a transition aid, not the end state.** It exists so unmigrated bespoke errors that reach `next(err)` still map sensibly. Once Phase 2 migrates everything to `AppError`, consider tightening it (or logging when it fires) — today it will happily map *any* error object with a numeric 4xx/5xx `statusCode`, including third-party library errors that were never meant for clients.
4. **`meta` is spread into the response body.** Anything placed in `AppError.meta` goes over the wire verbatim. Never put internal state, stack info, or secrets there. Also, `meta` keys can shadow `error`/`code` if named identically — don't.
5. **Wire-compat contract for Phase 2 migrations.** The middleware's `{ error, code, ...meta }` shape was chosen to match what routes already hand-roll, so migrating a route must be byte-compatible per endpoint. When migrating, diff each endpoint's current error JSON against what the middleware would emit (some routes emit extra fields like `raceId`, some omit `code`) — put per-endpoint extras in `meta` to preserve exact shapes. Shipped clients parse these bodies; the frozen-old-client rule applies to error responses too.
6. **`asyncHandler` is opt-in and currently unused by existing routes.** Existing handlers keep their try/catch until Phase 2. New routes should use `asyncHandler` + `AppError` from day one — do not add new hand-rolled try/catch + inline 500 blocks.
7. **Ordering constraint in `app.js`.** `errorMiddleware` must stay mounted last (after static/public routes), and the narrow 413 body-parser handler stays before it. Anything mounted after the error middleware would bypass central handling.
8. **Phase 2 sizing note.** The audit counts ~39 bespoke error classes and ~40 copy-pasted route mapping blocks. Tournaments already centralize (`services/tournamentErrors.js` + `sendError` in `routes/tournaments.js`) and are the easiest first migration **(✅ done as Phase 2a — see below)**; `usePowerup.js` (55 throw sites) is the hardest and should go last.

---

## Phase 2a implementation status (2026-07-21)

Migrated the tournaments domain — and only it — to the shared error infrastructure. Scope: `src/routes/tournaments.js` + `src/services/tournamentErrors.js`.

### What changed

- **`services/tournamentErrors.js`** — `TournamentError` now extends `AppError`. The legacy `(message, statusCode, code)` constructor signature is preserved, so none of the ~42 throw sites (nor the `ErrorClass`-injection callers in `raceBuyIns`/`validateRaceConfig`) changed. Two deliberate compat choices:
  - `statusCode` defaults to **400** (the old `sendError` default), not AppError's 500.
  - `code` has **no default** — after `super()`, the constructor re-assigns `this.code = code` to undo AppError's `INTERNAL_ERROR` default. Several throw sites pass no code (notably the buy-in/name validators), and shipped clients receive bodies **without** a `code` key there; `res.json` drops `undefined`, keeping that exact shape.
- **`routes/tournaments.js`** — all 14 handlers wrapped in `asyncHandler`; the per-route `try/catch` blocks and the `sendError` helper are deleted. Errors now flow to the central `errorMiddleware`. The public `GET /share/:token` 404 stays an inline `res.status(404)` (it's a normal branch, not a thrown error, and its body has no `code` key).

### Verification

- Unit: **1830 pass / 0 fail** before and after. Integration: **556 pass / 16 fail** before and after, failing list identical to the known pre-existing clusters (13 fanny-pack, 1 ad-coin gating, 2 hitchhike/quick-rinse). No regressions.
- Manual byte-level diff over real HTTP (new app vs a verbatim copy of the old `sendError` logic) for five scenarios: tournament full (409/`TOURNAMENT_FULL`), double join (409/`ALREADY_JOINED`), code-less validator error (400, **no `code` key**), not found (404/`TOURNAMENT_NOT_FOUND`), unknown internal error (opaque 500). **All five byte-identical** (status + body).

### Where `meta` was needed

Nowhere. No tournament endpoint emitted extra fields beyond `{ error, code? }`, so `meta` went unused in this pass. (Later domains — e.g. races routes that emit fields like `raceId` — will need it.)

### Notes for later phases

- **Behavior delta (accepted):** non-`TournamentError` failures used to be logged with a per-route label (e.g. "Join tournament error:"); the central middleware logs them as "Unhandled error:". Body/status unchanged.
- **Behavior delta (theoretical):** a non-TournamentError exception that happens to carry a numeric 4xx/5xx `statusCode` now maps to that status via the middleware's legacy branch, where old `sendError` would have flattened it to 500. Audit of the tournament command call graph found no such thrower (Prisma errors carry string `code`s like `P2025`, not numeric `statusCode`), so this is latent, not live.
- The migration recipe that worked here (preserve constructor signature; kill defaults that would add keys; byte-diff against a copy of the old serializer) is the template for migrating the remaining ~38 error classes and ~14 route files.

---

## Phase 3 implementation status (2026-07-21)

Unified the guarded coin-debit path. Scope: `commands/deductCoinsAtomic.js`, `awardCoins.js`, `purchasePowerupItem.js`, `purchaseShopItem.js`.

### Pre-change investigation findings (the differences between the three debit copies)

1. **Transaction ownership** — `deductCoinsAtomic` opened its own `$transaction`; both purchase sites debit **inside** a larger interactive transaction that also writes the purchase-request row and inventory/ownership row. Calling the canonical function unchanged from inside those would have opened a *second* transaction (the debit could commit while the purchase rolled back). Resolved by adding an optional `tx` param.
2. **Error classes differ by site, same message/status** — "Insufficient coins" / 400 everywhere, but `InsufficientCoinsError` vs `PowerupPurchaseError` vs `ShopPurchaseError`. `routes/shop.js:67,101` branches on `error.name`, and both purchase commands rethrow on `instanceof` of their own class, so each site's class had to survive. Resolved with an optional `insufficientError` param.
3. **Free items** — the purchase sites skip both debit and ledger row when `priceCoins === 0`; canonical's `amount === 0` no-op is equivalent (no row). Call sites keep their `> 0` guard.
4. **refId semantics differ intentionally** — powerup uses the per-purchase `request.id` (must be unique per purchase under the `(userId, reason, refId)` unique index); shop uses `item.id` (safe because already-owned purchases short-circuit before the debit, so one buy per user per item); usePowerup's upgrade path uses `powerupId`. Passed through unchanged.
5. **`awardCoins` is NOT a mislabeled third debit copy** — it is a deliberately different contract: idempotent by `(userId, reason, refId)` with a P2002 fallback, ledger-first, and **unguarded** (allows negative amounts that can overdraw; the race/tournament buy-in "hold" path calls it with `-amount` after a non-atomic `ensureUserCanAfford` check). Left untouched per scope. ~~⚠️ Worth a future decision: a concurrent spend between `ensureUserCanAfford` and the buy-in hold can technically drive a balance negative — pre-existing, not introduced or changed here.~~ **✅ Fixed in Phase 4** — holds now debit through the guarded path (see below).

### What changed

- `deductCoinsAtomic.js` is canonical, now accepting optional `tx` (run inside an existing Prisma transaction; without it, behavior is byte-identical to before, including the amount-0 read outside any transaction) and optional `insufficientError` (the exact error instance to throw on a failed guard; defaults to `InsufficientCoinsError`).
- `purchasePowerupItem.js` and `purchaseShopItem.js` replace their inlined `updateMany` guard + `coinTransaction.create` blocks with one `deductCoinsAtomic({ tx, ..., insufficientError })` call each. Only intra-transaction statement order changed (ledger insert now happens with the debit, before the inventory/ownership write, instead of after) — same committed state, invisible outside the transaction.
- `awardCoins.js`: untouched. `usePowerup.js` (the original caller): untouched, signature is backward-compatible.

### Verification

- Unit: **1830 / 0** before and after. Integration: **556 pass / 16 fail** before and after, failing list identical to the known pre-existing clusters. No regressions.
- Manual trace against the local integration DB, all three call sites: powerup purchase (100→70, ledger `{amount:-30, reason:"powerup_purchase", refId:<request.id>}` + inventory row), shop purchase (70→45, `{amount:-25, reason:"shop_purchase", refId:<item.id>}` + ownership row), standalone `deductCoinsAtomic` (45→30, `{amount:-15, reason:"powerup_upgrade", refId}`). Insufficient-balance attempts at all three sites threw the site's original error class (message/status preserved), wrote **zero** ledger rows, and left the balance untouched.

All three debit sites now share the single guarded code path; the `updateMany`-guard + ledger-insert pattern exists in exactly one place.

---

## Phase 4 implementation status (2026-07-21)

Two follow-ups: (a) the buy-in hold concurrency gap flagged in Phase 3, (b) extraction of the shared advisory-lock idiom.

### 4a. Buy-in hold concurrency fix

**The gap:** all five hold sites ran `ensureUserCanAfford` (non-atomic read) then `awardCoins(-amount)` (unguarded debit). Two simultaneous paid joins racing one wallet could both pass the check and drive the balance negative.

**Call sites changed** (the reserve call in each; `ensureUserCanAfford` stays as a fast-fail pre-check with unchanged error/timing):
`commands/joinRaceCore.js`, `respondToRaceInvite.js`, `createRace.js`, `joinTournamentCore.js`, `createTournament.js`.

**Design constraints discovered in Step 1 (why the fix is shaped this way):**
- Existing unit tests inject `awardCoins` fakes and assert the hold call `{userId, amount: -N, reason, refId}` — so the DI seam had to survive. Each command now defaults its hold to `buildAtomicHoldFn({ErrorClass, code})` (new, in `services/raceBuyIns.js`, re-exported by `tournamentBuyIns.js`) but an injected `dependencies.awardCoins` still takes both roles, so no test changed.
- The hold's **idempotent-replay contract is load-bearing**: race hold refIds are unversioned (`raceId:userId`), and TR-205 leave→rejoin relies on a duplicate hold resolving as a no-op rather than a P2002 500. `buildAtomicHoldFn` therefore reproduces `awardCoins`' full external contract — existing `(userId, reason, refId)` ledger row → `{awarded:false}`; P2002 race → no-op replay — but routes the actual debit through `deductCoinsAtomic` with the site's exact error (`"You do not have enough coins for this buy-in"`, 400, site ErrorClass, `INSUFFICIENT_COINS` code where the site used one; `createRace` stays code-less like its pre-check).
- All five sites previously used the **global-client** `awardCoins` (even `joinTournamentCore`, whose surrounding flow is transactional) — the guarded hold also runs on the global client, so transactional placement is unchanged everywhere.
- refId/reason values confirmed and preserved verbatim per site: `race_buy_in_hold`/`raceId:userId` and `tournament_buy_in_hold`/`tournamentId:userId:v{n}` (versioned).
- `awardCoins.js` itself: untouched (still the credit/refund/payout path).

**Verification:** unit 1830/0 → 1830/0; integration 556→**559 pass** (+3 = the new concurrency tests) / 16 fail, same pre-existing list. New `test/integration/buy-in-hold-concurrency.test.js`: two simultaneous paid joins with a wallet covering exactly one → exactly one 2xx, loser gets the original insufficient-coins error, final balance exactly 0 (never negative), exactly one hold ledger row; plus a duplicate-hold idempotency test. Under the old code the first test fails with balance −100 and two holds.

### 4b. Shared advisory-lock helper

**Step 1 diff of the two implementations** (beyond naming): tournament passes `tx` into the callback (writes run inside the locked transaction) and collects `deferred` post-commit events, returning `{result, deferred}`; race calls `callback()` bare (callers write via the global client; the transaction exists only to hold the lock); tournament accepts injectable `prisma`. Identical where it matters: `hashtext(id)` hashing, `pg_advisory_xact_lock` (auto-release on commit and rollback), throw→rollback→release. Neither was "more correct" — they differ in caller contract, not lock discipline, so nothing needed reconciling.

**What landed:** `src/shared/db/withAdvisoryLock.js` — `withAdvisoryLock(id, fn, {prisma})`, `fn(tx)`, carrying the lock discipline once (with a keep-`fn`-short warning per the cron-outage lesson). `raceJoinLock.js` and `tournamentLock.js` are now thin wrappers preserving their exact external interfaces (`withRaceJoinLock(raceId, callback)` still calls back with no args; `withTournamentLock` still returns `{result, deferred}`); no caller changed.

**Verification:** unit 1830/0 and integration 559/16, both identical to post-4a baseline. Manual concurrency check through the shared helper against the integration DB: same id → serialized (second caller entered 2ms after a 300ms-held lock released); different ids → concurrent (no blocking).

---

## Phase 5 implementation status (2026-07-21)

Unified the buy-in reserve/refund/payout pattern into `src/shared/economy/buyIns.js`. Scope: that new module plus `services/raceBuyIns.js` and `services/tournamentBuyIns.js`.

### Step 1 diff findings

The six functions (race reserve/refund/payout; tournament reserve/refund/payout + `mintChampionPrize`) were all the same 5-line shape — `if (!amount) return null; return awardCoinsFn({userId, amount: ±amount, reason, refId})` — zero-amount no-op, idempotent-ledger delegation, global-client placement on both sides (no transactional differences anywhere). The real differences are **intentional per-domain conventions**, kept as parameters rather than reconciled:
- **Versioning:** tournament refIds are versioned (`tid:uid:v{n}`, bumped at refund so a re-hold debits for real); race refIds are unversioned (`raceId:userId`) with the documented leave→rejoin replay quirk.
- **Payout keying:** race payout dedups per **placement** (`raceId:placement` — the user is not in the refId); tournament pot pays `tid:champion`.
- **Tournament-only extra:** `mintChampionPrize` (`tournament_champion_reward`) kept distinct from the pot payout (`tournament_payout`) so seeded and paid tournaments never collide.
- Refund/payout/mint are **credits** — correctly unguarded (a credit cannot overdraw); only the reserve half needed the Phase 4a guard.

### What landed

- `shared/economy/buyIns.js`: `holdBuyIn` (negating reserve), `creditBuyIn` (refund/payout/mint), plus `buildAtomicHoldFn` and `ensureUserCanAfford` **moved here** from `raceBuyIns.js` (this also removes the `tournamentBuyIns → raceBuyIns` cross-domain import from the coupling table).
- `raceBuyIns.js` / `tournamentBuyIns.js`: thin wrappers supplying each domain's reason strings and refId templates verbatim. Every previously-exported name (incl. re-exports of `buildAtomicHoldFn`/`ensureUserCanAfford`, and race-only `validateRaceBuyInConfig`) is preserved with identical signatures — **no caller changed**.

### Verification

- Unit **1830/0** and integration **559 pass / 16 fail**, both identical to baseline (same pre-existing failures).
- Manual lifecycle traces on the integration DB through the real functions: **race** reserve→refund (100 held, 100 back, exact `race_buy_in_hold`/`race_buy_in_refund` rows on `raceId:userId`) and reserve→payout (placement-keyed `raceId:1` row; replay of the same placement is a no-op, no double-pay); **tournament** reserve v0→refund v0→re-reserve v1 (the versioned re-hold genuinely debits — no stale no-op) and payout+mint (distinct reasons on the shared `tid:champion` refId). Zero-amount calls return `null` and write nothing. All balances matched pre-change arithmetic exactly.

---

## Phase 6 investigation: race/tournament command-pair unification (2026-07-21)

**Investigation only — no code was changed.** Function-by-function diff of all six race/tournament command pairs (leave, forfeit, kick, cancel, invite, shareLink), as groundwork for the `competition-core/` extraction proposed in §6.

**Headline:** the pairs are *less* mirror-like than §4's duplication table implied. The genuinely shared spine is the **guard prelude** (not-found 404 → permission 403 → state-window gate) and the **refund-HELD-buy-in step**; the mutation/completion halves differ structurally per pair (hard-delete vs soft-remove, sync events vs deferred vs none, lock-free vs locked). A "unify everything" helper would be forced to grow a flag per divergence — the realistic extraction is small composable guards plus a refund step, not one mega-function. Two prerequisites surfaced that matter more than the dedup itself: **three tournament commands have zero tests**, and **locking discipline is inconsistent** in ways a refactor could silently change.

### Per-pair findings

**Pair A — leaveRace vs leaveTournament.** Same shape: not-found 404, creator-cannot-leave 400, PENDING-only gate, refund-if-HELD. Differs: membership failure is 403/existence (race, `leaveRace.js:60-63`) vs 404/must-be-ACCEPTED (tournament, `leaveTournament.js:43-52`); race **hard-deletes** the participant row (`leaveRace.js:75`) while tournament **soft-removes** (status→DECLINED, buyInStatus→REFUNDED, `buyInVersion+1` via `softRemoveAndRefund`, `tournamentParticipants.js:20-27`); race emits `RACE_PARTICIPANT_LEFT`, tournament emits nothing; race returns `{success:true}`, tournament returns a serialized payload. Race-only: `TOURNAMENT_RACE_LOCKED` guard + team-races-only affordance (TR-205/208). Tournament-only: version bump, `supportsCharacters` threading, runs inside `withTournamentLock` (race side is lock-free).

**Pair B — forfeitRace vs forfeitTournament.** The most asymmetric pair (297 vs 75 lines). Shared spine is only: not-found 404, stamp `forfeitedAt`, "other side wins via `completeRace`". Race-only: effective-total freeze incl. leech/hitchhike/effects math (`forfeitRace.js:59-142,186-196`), TR-603 team collapse with conditional `completeRace`, TR-604 `SELECT … FOR UPDATE` inside `$transaction` (`:199-239`), idempotent conditional write, feed row + eventBus emit. Tournament-only: *queries for* the live matchup (409 `NO_LIVE_MATCHUP`, `forfeitTournament.js:43-49`), completes the matchup unconditionally (bracket advancement lives inside `completeRace`), **no transaction or lock at all** despite mutating shared bracket state. Neither side touches buy-ins (committed after start, by design) — payouts are `completeRace`'s job.

**Pair C — kickRaceParticipant vs kickTournamentParticipant.** Same shape: not-found 404, creator-only 403. Differs: race allows kicks in PENDING **and** ACTIVE, tournament is PENDING-only (409); race has a self-kick guard, tournament doesn't; tournament requires target status ACCEPTED; race hard-deletes + emits `RACE_PARTICIPANT_KICKED`, tournament soft-removes (version bump) + emits **nothing**; race returns `{success:true}`, tournament a serialized payload; race is lock-free, tournament runs in `withTournamentLock`.

**Pair D — cancelRace vs cancelTournament.** The closest behavioral mirror: not-found 404, creator-only 403, refund-all-charged loop, flip to CANCELLED (neither deletes rows). Differs: race cancels PENDING+ACTIVE with distinct already-completed/already-cancelled errors, tournament is PENDING-only 409 (post-start = forfeit instead); tournament bumps `buyInVersion` per refund and stamps `completedAt`; race emits one sync `RACE_CANCELLED` with an id list (ACCEPTED only), tournament defers one `TOURNAMENT_CANCELLED` per recipient (ACCEPTED+INVITED, with `buyInAmount`) until after the lock commits; featured tournaments are implicitly uncancellable (`creatorId === null` fails the creator check). Race lock-free; tournament locked.

**Pair E — inviteToRace vs inviteToTournament.** Same shape: not-found 404, creator-only 403, friendship-must-be-ACCEPTED lookup, INVITED row creation, per-invitee event emit. The **policies are opposite**: race throws on any bad invitee (non-friend 403, already-participant 400, capability 400 `INVITEE_NEEDS_UPDATE` for team races), tournament silently skips and reports partial success (`invited`/`needsUpdate` arrays), and re-flips DECLINED→INVITED where race hard-errors. Race enforces `maxParticipants` (except team races, TR-207) and stamps a 24h `inviteExpiresAt`; tournament enforces **no capacity at invite time** and has no invite TTL. Neither touches buy-ins (tournament's event payload carries `potCoins`/`buyInAmount` as display data only). Neither side locks or uses a transaction — tournament's per-invitee create/update loop is not atomic across the batch.

**Pair F — createRaceShareLink vs createTournamentShareLink.** A true near-mirror: not-found 404 → any-ACCEPTED-participant 403 (explicitly not creator-only, both headers) → reuse existing token (idempotent, neither ever rotates) → mint via the same `utils/shareToken.generateShareToken` → persist → return `{shareToken}`. Only differences: race's `TOURNAMENT_RACE_LOCKED` guard, model-method vs raw-prisma persistence, error class/codes, and route-level wrapping (tournament route adds `url` + 201). This is the easiest pair to unify.

### Phase 5 helper usage (item 3)

All refund paths that exist in these 12 commands go through the services transitively into `shared/economy/buyIns.js` — none carry stale pre-Phase-5 inline ledger writes:
- `leaveRace.js:5,67-72` → `refundRaceBuyIn`; `cancelRace.js:5,46-51` → `refundRaceBuyIn`; `kickRaceParticipant.js:5,49-56` → `refundRaceBuyIn`.
- `leaveTournament.js` + `kickTournamentParticipant.js` → `softRemoveAndRefund` (`services/tournamentParticipants.js:1,12-18`) → `refundTournamentBuyIn`; `cancelTournament.js:7,43-49` → `refundTournamentBuyIn` with `version: p.buyInVersion || 0`.
- Both forfeits and all four invite/shareLink commands import **no** buy-in functions (correct: forfeit commits the buy-in; invites/links hold no coins). No command anywhere inlines a raw `awardCoins` ledger write for a refund.

### Test coverage per command (item 4)

| Pair | Race side | Tournament side | Gap |
|---|---|---|---|
| leave | 3 unit (fakes) + integration hits (team-races) | **0 unit**; 1 combined integration test | Thin |
| forfeit | 5 unit + team-races integration | **0 unit**; 1 integration assertion | **Severe** (drives bracket advancement) |
| kick | 6 unit | **zero tests of any kind** | **Severe** |
| cancel | Broad integration (5+ cases + dedicated refund test) | 1 combined integration + 1 seed case | Modest |
| invite | 6 unit + 8 integration | **zero tests** (partial-success/re-flip/gating all untested) | **Severe** |
| shareLink | 6 unit + integration (share.test.js) | **zero tests** | **Severe** |

Every pair is lopsided toward the race side. `kickTournamentParticipant`, `inviteToTournament`, and `createTournamentShareLink` have no direct tests at all. **Per this repo's rules, tests-first: the tournament sides need coverage written *before* any unification refactor, or regressions there would be invisible.**

> **✅ Update (2026-07-21, same day):** the four gaps above are closed — `test/integration/tournament-lifecycle-commands.test.js` adds 12 end-to-end tests through the real routes (commands untouched):
> - **kick (3):** happy-path soft-remove to DECLINED; HELD buy-in refund with `buyInVersion` bump + exact ledger row (`tournament_buy_in_refund`, `tid:uid:v0`); guard matrix (non-creator 403 `NOT_CREATOR`, non-ACCEPTED target 404 `PARTICIPANT_NOT_FOUND`, started 409 `TOURNAMENT_NOT_PENDING`, unknown 404 `TOURNAMENT_NOT_FOUND`).
> - **invite (4):** happy path; partial-success batch (non-friend/already-in/self skipped silently with no rows, featureless friend → `needsUpdate` with no row); DECLINED→INVITED re-flip; non-creator 403 + started 409.
> - **share-link (3):** creation-minted token reuse with `url`, idempotent across calls *and* callers (any ACCEPTED participant); defensive re-mint when the stored token is null (32-hex, persisted); INVITED-only 403 `NOT_INVITED`, stranger 403, unknown 404.
> - **forfeit (2):** freeze + unconditional matchup completion + advancement (forfeiter `eliminatedInRound=1`, opponent alive, race COMPLETED with time remaining); `NO_LIVE_MATCHUP` 409 for eliminated player, between-rounds winner, and unrelated user, vs 404 for unknown tournament.
>
> Suite counts: unit 1830/0 unchanged; integration 575→587 tests, 571 pass / 16 fail — the same pre-existing failures (their pass/fail parent accounting wobbles between 16 and 17 run-to-run; the leaf-failure set is identical, and the suite minus those three files passes 544/544). Pair-unification work can now proceed against this baseline.

### Proposed shared shape (item 5)

Not one `runLifecycleAction` mega-helper — the diffs show the mutation halves are genuinely domain-specific, and a single function would need a flag per divergence (delete-vs-soft-remove, sync-vs-deferred-vs-no events, lock-vs-none, throw-vs-skip invitee policy). Instead, a small `shared/competition/lifecycle.js` of composable guards used *inside* each domain's lock/transaction discipline:

- `getCompetitionOrThrow(fetch, {notFoundError})` — the 404 prelude.
- `assertCreator(entity, userId, {error})` / `assertParticipantAccepted(...)` — the 403s.
- `assertStatusIn(entity, allowed, {error})` — the state-window gate (parameterized because the windows *intentionally* differ: kick/cancel PENDING+ACTIVE for races vs PENDING-only for tournaments).
- `refundHeldBuyIn({participant, refundFn, awardCoinsFn, onRefunded})` — the shared "if HELD && amount>0 → refund → mark REFUNDED (+ optional version bump callback)" step (today inlined 3× on the race side and wrapped in `softRemoveAndRefund` on the tournament side).
- Reuse-or-mint share-token helper — Pair F's whole body except the persistence call.

Per pair — what the shared helpers absorb vs what stays domain-specific:

| Pair | Absorbable | Stays domain-specific |
|---|---|---|
| leave | 404/403 guards, PENDING gate, refund step | delete vs soft-remove+version, event emit, response shape, team-race affordance, lock choice |
| forfeit | 404 guard only | everything else (step-freeze math, collapse, matchup lookup, FOR UPDATE) — **recommend excluding forfeit from unification** |
| kick | 404/creator/state guards, refund step | self-kick rule, ACTIVE-kick window, delete vs soft-remove, event vs none |
| cancel | 404/creator guards, refund-all loop, CANCELLED flip | state window, version bump, `potCoins`/`completedAt` extras, sync vs deferred events, recipient sets |
| invite | 404/creator guards, friendship lookup | the entire throw-vs-skip policy split, capacity, TTL, re-flip, capability gating — **low unification value; policies are opposite by design** |
| shareLink | nearly everything (guards, reuse-or-mint, token gen) | race's tournament-lock guard, persistence call, error codes |

**Recommended order if/when implemented:** (1) write the missing tournament-side tests **(✅ done — see coverage update above)**; (2) unify Pair F (near-mirror, lowest risk) **(✅ done — see Phase 7 below)**; (3) extract the guard + refund helpers and adopt them in leave/kick/cancel **(✅ done — see Phase 8 below)**; (4) leave invite and forfeit as domain code **(standing decision)**. Also worth a decision while in here (pre-existing, unchanged): `forfeitTournament` mutates bracket state with no lock or transaction, and the race-side leave/kick/cancel run lock-free with non-atomic refund→mutate sequences — the refactor should not paper over these, but fixing them is a behavior change to schedule deliberately.

---

## Phase 7 implementation status (2026-07-21)

Unified Pair F (share links) via the new `src/shared/competition/lifecycle.js` — the first adoption of the Phase 6 proposed guards. Scope: that module plus `commands/createRaceShareLink.js` and `commands/createTournamentShareLink.js`.

### What the shared module absorbed

- `assertFound(entity, makeError)` — the not-found prelude (both commands' 404).
- `assertAcceptedParticipant(entity, userId, makeError)` — the any-ACCEPTED-participant gate (both 403s), tolerating a missing participants array.
- `reuseOrMintShareToken({entity, mintToken, persist})` — the idempotent reuse-or-mint body: return the existing token, else mint once and hand it to the caller's persistence function.

Errors are lazy factories supplied per call site, so the helpers own only the checks — never the wire shape.

### What stayed domain-specific (per the task's preservation list)

- Race's `TOURNAMENT_RACE_LOCKED` guard — inline in `createRaceShareLink.js`, unchanged.
- Persistence: race via `raceModel.update(raceId, {shareToken})`, tournament via raw `db.tournament.update` — each passed in as the `persist` callback.
- Error classes/codes: `RaceShareLinkError` (404/403 code-less) and `TournamentError` (`TOURNAMENT_NOT_FOUND` / `NOT_INVITED`) exactly as before.
- Routes untouched — the tournament route's `url` field + 201 wrapping and the race route's shape are unchanged; both commands still export the same names (incl. `build*` DI factories), so no caller changed.

### Verification

Unit **1830/0** and integration **587 tests / 571 pass / 16 fail** — identical to the post-Phase-6-tests baseline (same pre-existing failures). Coverage on both sides exercised the shared path: the race side's 6 unit tests + `share.test.js` integration, and the tournament side's 3 new lifecycle tests (token reuse across callers, defensive re-mint, full guard matrix) all pass through the new helpers.

Next candidates per the Phase 6 plan: adopt `assertFound`/creator+state guards and a shared `refundHeldBuyIn` in leave/kick/cancel; leave invite and forfeit as domain code.

---

## Phase 8 implementation status (2026-07-21)

Extended `shared/competition/lifecycle.js` with the leave/kick/cancel guards and adopted them in all six commands (`leaveRace`, `leaveTournament`, `kickRaceParticipant`, `kickTournamentParticipant`, `cancelRace`, `cancelTournament`) plus `services/tournamentParticipants.js` (`softRemoveAndRefund`, where the tournament leave/kick refund step actually lives). Forfeit and invite untouched per the Phase 6 standing decision.

### New shared helpers

- `assertCreator(entity, userId, makeError)` — creator-only 403; encodes the featured-competition quirk for free (null `creatorId` matches no caller).
- `assertStatusIn(entity, allowedStatuses, makeError)` — parameterized state window; callers pass their own list (race kick/cancel: PENDING+ACTIVE; tournament everything: PENDING-only). A caller needing distinct errors per bad status calls it more than once excluding one status at a time (used by `cancelRace` to keep its separate already-completed / already-cancelled errors, COMPLETED checked first).
- `refundHeldBuyIn({participant, awardCoinsFn, refundFn, onRefunded, refundableStatuses})` — the shared "if charged → refund → domain follow-up" step. `refundFn` owns the domain reason/refId (wraps `refundRaceBuyIn`/`refundTournamentBuyIn`); `onRefunded` is the domain hook (race cancel: flag REFUNDED; tournament cancel: flag + `buyInVersion` bump; race leave/kick: nothing — row deleted after). One discovery forced a design addition: **`cancelRace` refunds COMMITTED as well as HELD** (`findChargedByRace` returns both, because ACTIVE races are cancellable) — so the helper takes `refundableStatuses`, defaulting `["HELD"]`, widened only at that call site. A literal HELD-only helper would have silently dropped refunds for ACTIVE-race cancels.

### Absorbed vs domain-specific per command

| Command | Absorbed | Stayed domain-specific |
|---|---|---|
| leaveRace | `assertFound`, `assertStatusIn(["PENDING"])`, `refundHeldBuyIn` | `TOURNAMENT_RACE_LOCKED` + team-race-only guards, creator-cannot-leave (inverse of `assertCreator` — kept inline), the distinct ACTIVE→409 `RACE_ALREADY_STARTED` error, hard delete, `RACE_PARTICIPANT_LEFT` emit, `{success:true}`, lock-free |
| leaveTournament | `assertFound`, `assertStatusIn(["PENDING"])` (+`refundHeldBuyIn` via `softRemoveAndRefund`) | creator-cannot-leave inline, ACCEPTED-membership 404, soft-remove + unconditional version bump, serialized payload, `withTournamentLock` |
| kickRaceParticipant | `assertFound`, `assertCreator`, `assertStatusIn(["PENDING","ACTIVE"])`, `refundHeldBuyIn` | `TOURNAMENT_RACE_LOCKED`, self-kick guard, hard delete, `RACE_PARTICIPANT_KICKED` emit, lock-free |
| kickTournamentParticipant | `assertFound`, `assertCreator`, `assertStatusIn(["PENDING"])` (+refund via `softRemoveAndRefund`) | target-must-be-ACCEPTED 404, soft-remove, no event, serialized payload, `withTournamentLock` |
| cancelRace | `assertFound`, `assertCreator`, `assertStatusIn` ×2, `refundHeldBuyIn` (`["HELD","COMMITTED"]`, `onRefunded` flags REFUNDED) | `TOURNAMENT_RACE_LOCKED`, `potCoins: 0`, single sync `RACE_CANCELLED` to ACCEPTED-only, returns the updated row, lock-free |
| cancelTournament | `assertFound`, `assertCreator` (featured quirk preserved), `assertStatusIn(["PENDING"])`, `refundHeldBuyIn` (`onRefunded` flags + bumps version) | `completedAt` stamp, per-recipient deferred `TOURNAMENT_CANCELLED` (ACCEPTED+INVITED, with `buyInAmount`), `{success:true}`, `withTournamentLock` |

Every exported name/signature (incl. `build*` factories and error classes) is unchanged — no caller anywhere was touched. `softRemoveAndRefund` keeps its unconditional decline+bump row update outside the helper (soft-remove updates the row refund-or-not, unlike cancel's refund-conditional hook).

### Verification

- Unit **1830/0** and integration **587 / 571 pass / 16 fail** before and after — identical, same pre-existing failures. The Phase 6-era test additions (kick refund + version bump, cancel refund matrix, leave/kick guard matrices on both sides) all exercise the new shared path.
- Manual traces on the integration DB: **(1)** race leave with a HELD 50-coin buy-in → +50 `race_buy_in_refund` on `raceId:userId` and the participant row **hard-deleted**; **(2)** tournament kick with a HELD buy-in → +50 `tournament_buy_in_refund` on the `:v0` refId, row kept as DECLINED/REFUNDED with `buyInVersion` 0→1; **(3)** full cancels on both domains — an ACTIVE paid race refunded both its HELD **and** COMMITTED participants (the widened window doing real work), flagged them REFUNDED, flipped to CANCELLED with `potCoins` zeroed; the tournament cancel refunded every HELD participant, bumped each version to 1, and flipped to CANCELLED with `completedAt` stamped.

---

## Phase 9 investigation: §6 target structure reconciled against the current tree (2026-07-21)

**Investigation only — no files were moved.** The §6 plan was written against the pre-Phase-1 tree; Phases 1–8 built parts of `shared/` and deleted 9 files, so every listing below was re-enumerated from the live tree, not the original audit tables.

### 1. shared/ — built vs still-proposed

**Already built (Phases 1–8):** `shared/errors/AppError.js`, `shared/http/{errorMiddleware,asyncHandler}.js`, `shared/db/withAdvisoryLock.js`, `shared/economy/buyIns.js`, `shared/competition/lifecycle.js`.

**Not yet built — candidate files verified present at their audited paths, with move-safety findings:**

| Proposed | Files (all exist today) | Safe to move as-is? |
|---|---|---|
| `shared/middleware` | `utils/clientFeatures.js` (2 consumers), `utils/releaseChannel.js` (6) | ✅ Pure functions, no imports — trivial moves. |
| `shared/push` | `services/apns.js`, `services/fcm.js` (1 consumer each: `notificationHandlers`) + `services/stepSyncPush.js` (broadest fan-in: steps commands, races route, friends route, jobs, handlers) | ⚠️ `apns.js`/`fcm.js` build **eager singletons at import** that read `APNS_*`/`FCM_*` env — path-safe (no src imports) but make the singleton lazy when moving, or preserve import order. |
| `shared/events` | `events/eventBus.js` | ⚠️ **44 inbound requires** and a module-level mutable `Map` — the singleton is the point. Move in ONE atomic change updating all 44; a transitional re-export shim would still be a single instance and is acceptable, dual copies are not. |
| `shared/time` | `utils/week.js` (7 consumers), `utils/etSchedule.js` (3, imports `./week` — move together). **`utils/raceTimeZone.js`: recommend NOT moving to shared** — all 6 consumers are race-domain; it belongs in `modules/races`. | ✅ Pure date math. |
| `shared/lib` | `lib/profanity.js` (eager `bad-words` Filter at import — cheap, fine), `lib/displayNameValidator.js` (imports `./profanity` — move together), `lib/referralCode.js` (pure). **`utils/shareToken.js`: borderline** — all 4 consumers are race/tournament share flows; either shared/lib or leave for the competition modules. | ✅ with the noted pairings. |

No candidate imports Prisma/models; the only hazards are the two eager singletons and eventBus's fan-in.

### 2. Current file-to-module assignment (re-verified, post-Phase-1–8 tree)

Current counts: commands 72, queries 37, services 33, utils 24, models 23 (after the dead-file sweep). Full per-module lists were re-derived from live `ls` + require-graphs; summary:

- **races** (~48 files): 22 commands (create/edit/start/cancel/complete/forfeit, join family, invite/kick/leave/share-link, chat-mute/results-seen, autoJoinFeaturedRaces, expireEffects†), 12 queries (getRaceProgress, getRaceDetails/Feed/Races/Featured/Public(+Count)/DiscoverySummary, getHomeRaceCard†, getSharedRacePreview, getRaceMessages†, getRaceInventory†), 9 services (raceStateResolution, raceBaseline, raceIllusions, raceJoinLock, racePowerupStateSync, withRaceResolutionLock, reconcileUploaderRaces, raceBuyIns, validateRaceConfig), 4 jobs (raceExpiry, raceResolutionQueue, autoStartScheduledRaces, seededRaceRenewal), 5 models, utils (racePayoutPresets, raceSteps, raceTimeZone, teamRaces), constants (raceFinishReward, teamNames). († = contested, see §3 table.)
- **tournaments** (~28 files): 13 commands, 5 queries (incl. `serializeTournament.js` — the wire serializer; keep in-module despite living in `queries/`), 7 services, 1 job, 1 model, 1 constants.
- **competition-core: DO NOT CREATE.** Everything §6 imagined for it already landed as `shared/competition` + `shared/economy` + `shared/db` (verified: 9 live consumers of `lifecycle.js`, both buy-in wrappers on `shared/economy/buyIns`, both locks on `withAdvisoryLock`). The domain wrappers (`raceBuyIns`, `tournamentBuyIns`, `raceJoinLock`, `tournamentLock`) stay inside their modules. §6 is amended accordingly.
- **powerups** (~28 files): usePowerup/rollPowerup/discard/redeem/grant/purchase/expireEffects/mystery-box commands, 7 models (racePowerup, racePowerupEvent, raceActiveEffect, userPowerupItem, powerupShopItem, powerupCopy, powerupUpgradeEvent), odds/upgrades/hitchhike/leech utils, gating/copy-seed constants, 5 queries, powerups route. Both race modules reach into it constantly — it must exist as a module *before* races moves.
- **economy** (~20 files): awardCoins, deductCoinsAtomic, daily-reward + ad-reward commands/queries/routes, balanceConfig(+defaults)+balanceSnapshot, dailyBoxOdds, admobSsv, adRewards config, dailyReward constants.
- **cosmetics** (7): purchaseShopItem, equipAccessory, grantLegendCosmetic, shopCosmetics, mirrorShopItem (+peerDb coupling), getShopCatalog, getUnownedAccessoryPool. (No `userShopItem` model file exists — ownership rows are raw-prisma.)
- **social** (~20): friends + referrals routes/commands/queries/models/config, race chat (sendRaceMessage/deleteRaceMessage/getRaceMessages/raceMessage model — race-bound but social by function).
- **ranked** (17): routes/queries (v1+v2 — v1 is old-client compat, moves but never deleted), 3 services, 2 models (note: `models/season.js` is also consumed by `routes/steps.js`), settle commands, 2 jobs, 4 constants.
- **leaderboard** (3): route, getLeaderboard, recordLeaderboardRankings. Depends only on `utils/week` + friendship model. Smallest, cleanest module.
- **home** (3): route + getHomeRaceCard + getRaceDiscoverySummary — a cross-cutting *aggregator* (imports steps/economy/races); it will always have many outbound edges wherever it lives.
- **analytics** (2–3): analytics route (raw prisma, no model file exists), activationEventCleanup job; `getAdminStats` is dual with admin.
- **admin** (5–6): admin route, requireAdmin, adminAccess, appSettings, balanceSnapshot†, getAdminStats†.
- **web** (5): the 4 `src/web/` renderers + `config/sharing.js` (consumed by social + both share-link commands — exported via web's index).
- **notifications/push:** per §1, `apns`/`fcm`/`stepSyncPush` go to `shared/push` (infrastructure), while `notificationHandlers`, `eventHandlers`, `models/notification`, `notificationCleanup`/`dailyRewardReminder`/`dailyMover` jobs form a thin **notifications** module. `models/deviceToken` + `routes/notifications.js` are dual with users (see §3).

### 3. Contested files — proposed homes and what the cross-module call becomes

| File | Lands in | Cross-module call becomes |
|---|---|---|
| `commands/completeRace.js` | races | `require("modules/tournaments")` → `advanceTournament`, `resolveMatchupWinner` via tournaments' index. This is the **one sanctioned races→tournaments edge** (with `raceExpiry.js`, same import). |
| `commands/advanceTournament.js` | tournaments (public-interface export) | Called by races via tournaments' index. Its own `tournamentRounds → raceBaseline` + Race-row creation becomes `require("modules/races")` → `snapshotBaselineFields` + race-creation surface — **races↔tournaments is a genuine require cycle at module level.** Mitigation options: (a) move both modules in one step and allow exactly these two index-level imports (Node tolerates the cycle today; it already exists via the same files), or (b) invert one direction through eventBus. Recommend (a) first — no behavior change — with (b) as a later cleanup. |
| `queries/getRaceProgress.js` ⇄ `services/raceStateResolution.js` | races (both) | The confirmed intra-module cycle (lazy require at `getRaceProgress.js:818`) moves intact; §6's split of raceStateResolution into pure-scoring vs orchestration is the eventual fix, out of scope for a move. |
| `queries/serializeTournament.js` | tournaments | Its `raceIllusions` import becomes a races-index import (or `collectRaceIllusions` graduates to shared/competition — decide at move time). |
| `queries/getTournamentsForUser.js` | tournaments | Race model reads become races-index calls (`RacePowerup`, `RaceActiveEffect` accessors). |
| `commands/createTournament.js` → `validateRaceConfig` | tournaments → races index | `validatePowerupConfig` exported from races (or hoisted to shared/competition — it's competition-generic). |
| `services/racePowerupStateSync.js` → `rollPowerup` | races → powerups index | Sanctioned races→powerups edge. |
| Daily-reward cluster (`claimDailyReward*`, `getDailyRewardStatus`) | economy | Imports `getEligiblePowerupPool`/`grantPowerupToUser` from powerups' index and `getUnownedAccessoryPool` from cosmetics' index — economy→powerups and economy→cosmetics are sanctioned edges. |
| `openMysteryBox(+Batch)` | powerups | Its `balanceConfig` use = powerups→economy index import. |
| `claimStepMilestone` + route + constants + `getStepMilestonesToday` | steps (owns milestones) | `awardCoins` via economy's index; home imports `getStepMilestonesToday` via steps' index. |
| `routes/shop.js` | stays a thin composition router (like home/auth) | Imports cosmetics' and powerups' indexes — route files that aggregate two modules are composition points, not module members. Same ruling for `routes/home.js` and `routes/auth.js`. |
| `models/deviceToken.js` + `routes/notifications.js` | deviceToken → **shared/push** (it's push infrastructure both users and notifications need); notifications route → notifications module | users imports prefs surface via notifications' index. |
| `services/appSettings.js` | admin | auth.js consumes via admin's index (flag reads). |
| `queries/getAdminStats.js`, `services/balanceSnapshot.js` | admin / economy respectively | admin imports balanceSnapshot via economy's index. |
| `utils/mirrorShopItem.js` | cosmetics (with its `peerDb` coupling documented) | admin → cosmetics index. |
| `models/season.js` | ranked | `routes/steps.js` reads SeasonScore via ranked's index. |
| `utils/appleSubHash.js` | users | social's referral commands import via users' index (or hoist to shared/lib — tiny pure fn, either works). |

### 4. Proposed move order

Ordering rule: fewest cross-module dependencies first (prove the pattern where a move can't cascade), most-entangled last. Tournaments' deep Phase 2a/5/6/7/8 coverage is a safety asset, but that coverage equally protects a *late* move — it doesn't outweigh the dependency rule.

1. **leaderboard** — 3 files, outbound deps only on shared-candidates (`week`) + friendship model. No one imports *it* except `app.js`. The pattern-prover.
2. **shared/ completion** — move the §1 candidates (middleware, time, lib, push infrastructure, eventBus-in-one-commit). Not a module, but it must precede modules that would otherwise import `utils/week` at old paths.
3. **web** — 5 files; only inbound is `config/sharing` (social + share-link commands), exported via index.
4. **analytics** — 2–3 files, raw prisma only.
5. **ranked** — self-contained except two index-able edges (out: `grantLegendCosmetic`; in: steps reads `season`).
6. **cosmetics**, then **admin** — small; admin depends on cosmetics/economy indexes existing.
7. **users**, then **social** (social needs users' `appleSubHash` and web's `sharing`), then **notifications**.
8. **economy**, then **powerups** (mutually edged with economy; both must precede races).
9. **steps** (needs economy + shared/push in place; race-resolution imports still point at old race paths until step 10 — the moves must leave re-export shims or be ordered within one PR).
10. **races + tournaments together, last** — they are mutually recursive (`completeRace/raceExpiry → advanceTournament` and `tournamentRounds → raceBaseline` + race-row creation) and both lean on powerups/economy/steps. Moving them as one step with two sanctioned index-level imports avoids a half-moved cycle. **home** moves here too (it aggregates races).

Standing mechanics for every step: file moves only, no logic changes; each module gets an `index.js` public interface; old paths get one-line re-export shims until step 10 removes them (shims keep frozen imports working and make each step independently shippable); full suite green after each step.

### 5. Phase 9a dry run — modules/leaderboard file-by-file

| Old path | New path |
|---|---|
| `src/routes/leaderboard.js` | `src/modules/leaderboard/routes.js` |
| `src/queries/getLeaderboard.js` | `src/modules/leaderboard/getLeaderboard.js` |
| `src/utils/recordLeaderboardRankings.js` | `src/modules/leaderboard/recordLeaderboardRankings.js` |
| *(new)* | `src/modules/leaderboard/index.js` — exports `createLeaderboardRouter` (and nothing else; `getLeaderboard`/`buildRaceRecordLeaderboard` stay module-private unless a consumer appears) |

Required reference updates (verified current):
- `src/app.js:11` — `require("./routes/leaderboard")` → `require("./modules/leaderboard")` (mount line unchanged).
- Internal relative imports inside the three moved files: `getLeaderboard.js` requires `../db`, `../utils/week`, `../utils/shopCosmetics`, `../models/friendship`, `./recordLeaderboardRankings` — all become `../../…` except the last (unchanged); `routes.js` requires `../middleware/requireAuth` → `../../middleware/requireAuth`.
- `test/utils/recordLeaderboardRankings.test.js` — update its require path (move the test to `test/modules/leaderboard/` at the same time or leave in place with the new path; recommend moving for symmetry).
- Integration tests (`test/integration/leaderboard*.test.js`) exercise HTTP only — no path changes.
- Optional but recommended: leave `src/routes/leaderboard.js` and `src/queries/getLeaderboard.js` as one-line re-export shims for one step, then delete in the same PR once grep shows zero stale importers (currently only `app.js` imports the route; nothing else imports `getLeaderboard`; only the moved test imports `recordLeaderboardRankings`) — with such a small verified fan-in, shims can be skipped and the move done atomically.

Definition of done for 9a: files moved, `app.js` updated, unit + integration suites at the current baseline (1814/0 and 587 / 571 / 16), and a grep proving no `routes/leaderboard`, `queries/getLeaderboard`, or `utils/recordLeaderboardRankings` references remain. **(✅ executed — see Phase 9a implementation status below.)**

---

## Phase 9a implementation status (2026-07-21)

Executed the `modules/leaderboard` move — the first module of the §6/Phase 9 restructure, proving the move pattern.

### What landed

| Old path | New path |
|---|---|
| `src/routes/leaderboard.js` | `src/modules/leaderboard/routes.js` |
| `src/queries/getLeaderboard.js` | `src/modules/leaderboard/getLeaderboard.js` |
| `src/utils/recordLeaderboardRankings.js` | `src/modules/leaderboard/recordLeaderboardRankings.js` |
| *(new)* | `src/modules/leaderboard/index.js` — exports `createLeaderboardRouter` only; the query + rankings helpers are module-private |
| `test/utils/recordLeaderboardRankings.test.js` | `test/modules/leaderboard/recordLeaderboardRankings.test.js` |

All moves via `git mv` (history preserved). `src/app.js` now requires `./modules/leaderboard` (mount line unchanged). Internal relative imports updated per the dry-run list. No shims — fan-in was small enough to move atomically.

### Deviations from the dry run (both handled)

1. **One missed consumer:** `test/queries/getStepLeaderboardHidden.test.js` requires `queries/getLeaderboard` directly via `require.resolve` cache manipulation — invisible to the investigation's plain-require grep. Test-only consumer; its three references were updated. *Lesson for future moves: grep for `require.resolve` consumers too.*
2. **Test-glob gap:** `package.json`'s `test:unit` glob list did not cover `test/modules/**`, so the moved test would have **silently stopped running** (counts would not have flagged it). The glob was added — a harness accommodation for the new layout, required for every future module's tests.

### Verification

- Unit: **1814/0 before → 1814/0 after** (exact match confirms the moved test still runs under the new glob).
- Integration: 587 tests, 570/17 vs baseline 571/16 — the documented parent-accounting wobble; the normalized **leaf-failure lists diffed byte-identical** to baseline, and the two leaderboard integration files pass 33/33 in isolation.
- Stale-reference grep across `src/ test/ scripts/ docs/`: **zero hits** for `routes/leaderboard`, `queries/getLeaderboard`, or `utils/recordLeaderboardRankings`.

Next module per the Phase 9 order: **web** (after the shared/ completion step, if done in sequence).

---

## Phase 9b implementation status (2026-07-21)

Executed the **low-risk portion of the shared/ completion step**: `shared/middleware`, `shared/time`, `shared/lib`. Explicitly excluded per scope: `shared/push` and `events/eventBus.js` (higher fan-in risk, separate pass), and `utils/raceTimeZone.js` / `utils/shareToken.js` stay put per the Phase 9 §1 ruling (race-domain, not generic shared).

### What moved (all `git mv`, history preserved)

| Old path | New path |
|---|---|
| `src/utils/clientFeatures.js` | `src/shared/middleware/clientFeatures.js` |
| `src/utils/releaseChannel.js` | `src/shared/middleware/releaseChannel.js` |
| `src/utils/week.js` | `src/shared/time/week.js` |
| `src/utils/etSchedule.js` | `src/shared/time/etSchedule.js` (its `./week` require unchanged — same dir) |
| `src/lib/profanity.js` | `src/shared/lib/profanity.js` |
| `src/lib/displayNameValidator.js` | `src/shared/lib/displayNameValidator.js` (its `./profanity` require unchanged) |
| `src/lib/referralCode.js` | `src/shared/lib/referralCode.js` |

`src/lib/` is now empty and was removed. No index.js files — these are relocated shared utilities, required directly.

### Fan-in re-verification (Step 1 findings vs the investigation's counts)

The investigation's counts were **undercounts** — it counted src consumers only. Actual consumers found and updated: `week` 10 src (incl. three same-directory `./week` requires in `utils/streak.js`, `utils/raceSteps.js`, `utils/globalStepEvent.js` that path-greps miss) + 6 test files + 1 script; `etSchedule` +`models/jobRun.js` + `utils/globalStepEvent.js` (`./etSchedule`) + 1 test; `profanity` +2 test files; `displayNameValidator` +1 script +1 test; `referralCode` +1 integration test. All were the same kind of consumer (path updates), so the move proceeded; every reference was rewritten. *Lesson recorded: fan-in greps must also cover same-directory relative requires (`./x`), not just `dir/x` path fragments.*

### Verification

- Unit **1814/0** and integration **587 / 571 / 16** — byte-exact match to baseline, including the wobble landing on the same side.
- Stale-reference grep across `src/ test/ scripts/`: **zero hits** for any of the seven old paths.
- **Test-glob check:** no test files moved, so no glob change was needed this pass. However, the fan-in sweep surfaced a **pre-existing gap**: `test/lib/displayNameValidator.test.js` is not covered by `test:unit`'s glob list (`test/lib/**` was never in it) — it has been silently not running. It passes 27/27 when run directly (with the new shared path). Left out of the glob this pass to keep the exact-count verification contract; **recommended follow-up: add `test/lib/**` (or move the test under `test/modules`/`test/shared`) as a deliberate +27-test baseline change.**

---

## Phase 9c implementation status (2026-07-21)

Executed the **high-risk remainder of the shared/ completion step**: `shared/push` (apns, fcm, stepSyncPush) and `shared/events` (eventBus). This completes the shared/ portion of the Phase 9 plan.

### Fan-in re-verification

- **eventBus: exactly 44 consumers confirmed** (matching the investigation) — 33 commands, 2 handlers, 7 jobs, 2 services — enumerated file-by-file before the move and re-counted after: **44 files now require `shared/events/eventBus`, zero on the old path.** No test consumers exist (tests inject fakes via DI).
- One investigation delta: `stepSyncPush.js` also imports apns+fcm (the investigation credited only `notificationHandlers`); same-kind consumer, handled.

### What moved (all `git mv`)

| Old path | New path |
|---|---|
| `src/services/apns.js` | `src/shared/push/apns.js` |
| `src/services/fcm.js` | `src/shared/push/fcm.js` |
| `src/services/stepSyncPush.js` | `src/shared/push/stepSyncPush.js` |
| `src/events/eventBus.js` | `src/shared/events/eventBus.js` (`src/events/` removed) |

All 44 eventBus consumers plus the 10 apns/fcm/stepSyncPush consumers (incl. 3 test files, which stay under `test/services/` — already glob-covered) were rewritten in the same pass; **no shim was used** — the singleton never existed at two paths.

### Lazy-init: needed for apns only

- **`apns.js`: yes, converted.** `buildApnsService()` captured `APNS_*` env into closure consts at import, and the module doesn't load dotenv itself — correctness depended on someone requiring `db.js`/`index.js` (which call `dotenv.config()`) first. The default `apnsService` is now a lazy wrapper that builds on first send. Verified in a zero-env `node -e` run: require does not throw, and a send returns a graceful `{success:false, reason:"APNS_SIGNING_KEY or APNS_KEY_PATH must be configured"}` — config is read lazily. `buildApnsService` DI is unchanged.
- **`fcm.js`: no change needed** — it was already fully lazy by design (firebase-admin and `FCM_*` env are loaded on first send; module-load only sets flags).

### Verification

- Suites: unit **1814/0** and integration **587 / 571 / 16** — byte-exact match to baseline.
- **Manual (1) — push dispatch, both platforms:** through the moved modules, the real `stepSyncPush` platform routing dispatched one iOS token via APNs (stubbed http2 transport; real ES256 JWT built from config, `apns-push-type: background`, correct device path) **and** one Android token via FCM (stubbed messaging; data message with `type: STEP_SYNC_REQUEST`), then stamped `lastSilentPushSentAt`.
- **Manual (2) — eventBus round-trip end-to-end:** with real `registerNotificationHandlers` (only outbound push stubbed) and seeded users/race/device-token on the integration DB, a real `cancelRace` command emitted `RACE_CANCELLED` on the moved singleton and the registered subscriber fired: a `Notification` row (type `RACE_CANCELLED`) was written for the other participant and the push stub was invoked — proving emitter and subscriber resolve the same singleton at the new path.
- Stale-reference grep (incl. `require.resolve` patterns): **zero hits** for any of the four old paths.

`shared/` is now complete per the Phase 9 plan (errors, http, db, economy, competition, middleware, time, lib, push, events). Remaining Phase 9 work is the module moves proper, next up: **web**.

---

## Phase 9d implementation status (2026-07-21)

Executed the **modules/web move** (next module per the Phase 9 order) plus the **Phase 9b glob-gap fix** as its Step 0.

### Step 0 — glob gap closed, new baseline

Added `test/lib/**/*.test.js` to `test:unit`: unit went 1814 → **1841 (+27 exactly, 0 failures)** — the silently-not-running `test/lib/displayNameValidator.test.js` is now permanently in the suite. New baseline: **1841/0 unit, 587/571/16 integration**.

### Fan-in re-verification (differed from the investigation — reported before moving)

- `config/sharing.js`'s consumers are **not** "social + both share-link commands": the actual consumers are the three **route** files (`routes/races.js`, `routes/tournaments.js`, `routes/referrals.js` — the commands never import sharing), `app.js`, `modules/web`-internal `deepLinkFiles.js`, and — caught only by the 9b same-directory-require lesson — **`config/appVersion.js`** (`require("./sharing")`, used for the store-URL fallbacks in the force-update gate).
- Renderer consumers: `app.js` + three `test/http` files (which stay in place, glob-covered). Renderer-internal same-dir requires (`referralLandingPage`/`tournamentLandingPage` → `./raceLandingPage`) move intact.

### What moved (all `git mv`, no renames, no shim)

| Old path | New path |
|---|---|
| `src/web/deepLinkFiles.js` | `src/modules/web/deepLinkFiles.js` |
| `src/web/raceLandingPage.js` | `src/modules/web/raceLandingPage.js` |
| `src/web/referralLandingPage.js` | `src/modules/web/referralLandingPage.js` |
| `src/web/tournamentLandingPage.js` | `src/modules/web/tournamentLandingPage.js` |
| `src/config/sharing.js` | `src/modules/web/sharing.js` |
| *(new)* | `src/modules/web/index.js` — the 8 renderer/deep-link exports app.js mounts + the `sharing` config surface as a named namespace export |

`src/web/` removed. Consumers updated: `app.js` collapses five requires into one module-index require; the three routes and `config/appVersion.js` import `sharing` via the index; the three landing-page tests point at the new paths.

### Verification

Unit **1841/0** and integration **587 / 571 / 16** — byte-exact match to the Step-0 baseline. Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for `config/sharing`, `src/web/`, or any renderer old path.

Next module per the Phase 9 order: **analytics**.

---

## Phase 9e implementation status (2026-07-21)

Executed the **modules/analytics move**.

### Fan-in findings

- `routes/analytics.js`: one consumer (`app.js`); the activation-events HTTP test exercises `createApp` only, no direct require.
- `jobs/activationEventCleanup.js`: two consumers — `src/index.js` (scheduler) and `test/jobs/activationEventCleanup.test.js` (direct require). `test/startup/index.test.js` references the job only through injected dependency names, no path.
- **getAdminStats disposition: stays with admin.** Confirmed on the live tree: it lives at `src/queries/getAdminStats.js`, its only production consumer is `routes/admin.js`, and its three dedicated test files are admin-stats tests. It has **zero analytics-side consumers**, so the "dual" framing resolves cleanly to the admin scope — it was not moved and will travel with `modules/admin` when that module moves.

### What moved (all `git mv`, no shim)

| Old path | New path |
|---|---|
| `src/routes/analytics.js` | `src/modules/analytics/routes.js` |
| `src/jobs/activationEventCleanup.js` | `src/modules/analytics/activationEventCleanup.js` |
| `test/jobs/activationEventCleanup.test.js` | `test/modules/analytics/activationEventCleanup.test.js` |
| *(new)* | `src/modules/analytics/index.js` — exports `createAnalyticsRouter` (mounted by app.js) + `scheduleActivationEventCleanup`/`buildCleanupActivationEvents`/`JOB_NAME` (consumed by index.js and tests) |

`app.js` and `src/index.js` now import via the module index; internal relative requires adjusted.

### Verification

Unit **1841/0** and integration **587 / 571 / 16** — byte-exact match to the Phase 9d baseline. Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for `routes/analytics` or `jobs/activationEventCleanup`.

Next module per the Phase 9 order: **ranked**.

---

## Phase 9f implementation status (2026-07-21)

Executed the **modules/ranked move** — 17 files, the first mid-sized module and the first with role subdirectories.

### Step 1 fan-in findings

- File list re-verified on the live tree: all 17 files present as the investigation described (route, 2 queries, 3 services, 2 models, 3 commands, 2 jobs, 4 constants).
- **Outbound edge confirmed:** `commands/settleRankedWeek.js:27` imports `grantLegendCosmetic` via same-dir `./grantLegendCosmetic` — cosmetics is unmoved, so this became the explicit cross-module path `../../../commands/grantLegendCosmetic` (to be revisited when `modules/cosmetics` lands).
- **Inbound edge confirmed:** `routes/steps.js` is the **only** production consumer of `models/season.js` outside the ranked domain (`SeasonScore.getActiveForUser`, one call site); no other steps-domain season reads exist. One extra consumer the investigation missed: `test/http/stepsStats.test.js` requires the model directly.
- Other discrepancies vs the investigation, all handled: `scripts/fix-ranked-v2-stale-tier-cohorts.js` consumes the cohorts service+constants; 8 test files require ranked internals directly.
- **Name collision found:** `services/rankedCohorts.js` vs `constants/rankedCohorts.js` — a flat module directory was impossible, so the module uses §6's role-subdirectory shape (`queries/ services/ models/ commands/ jobs/ constants/` + root `routes.js`), which also preserved every intra-module relative require unchanged.

### What moved (all `git mv`, no shim)

All 17 files → `src/modules/ranked/{routes.js, queries/, services/, models/, commands/, jobs/, constants/}`, names unchanged. `getRanked.js` (v1) moved intact — still mounted at `GET /ranked` for shipped binaries < 1.3.0, never deleted. New `index.js` exports `createRankedRouter` (app.js), `scheduleComputeRanks`/`scheduleComputeRankedWeeks` (index.js cron wiring), and `Season`/`SeasonScore` (the sanctioned steps inbound edge). Consumers updated: `app.js`, `src/index.js`, `routes/steps.js` (now reads SeasonScore via the ranked index), the script, and 9 test files (in place — glob-covered).

### Verification

- Unit **1841/0**, integration **587 / 571 / 16 with the leaf-failure set diffed byte-identical** to the canonical pre-existing list. (One first-pass miss — `test/jobs/computeRankedWeeks.test.js` also required `constants/rankedSettlement`, caught by the stale-grep + a single unit failure, fixed before final verification.)
- Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for any of the 17 old paths.

Next per the Phase 9 order: **cosmetics**, then **admin**.

---

## Phase 9g implementation status (2026-07-21)

Executed the **modules/cosmetics move** — 7 files, flat layout (no name collisions, per the leaderboard/analytics/web precedent).

### Step 1 findings

- File list confirmed on the live tree; **no `userShopItem` (or `userEquippedAccessory`) model file exists** — the investigation's raw-prisma-ownership note is still true.
- **Big discrepancy vs the investigation:** `utils/shopCosmetics.js` has **17 src consumers + 1 test**, not the narrow in-module role implied — its presentation surface (`characterPresentation`, `serializeShopItem`, `CHARACTER_SLOT`, …) is rendered by economy claim commands, race/tournament/social queries, the leaderboard and ranked modules, and admin. It is genuinely cosmetics-domain, so it moved with the module and the index **re-exports its entire surface**; all 18 consumers updated.
- `grantLegendCosmetic`: sole consumer is `modules/ranked/commands/settleRankedWeek.js` (the 9f reach-through) — **collapsed as planned** to a real module import (`require("../../cosmetics")`).
- `mirrorShopItem`: peerDb coupling confirmed (`getPeerPrisma`, no-op without `PEER_DATABASE_URL`); sole consumer `routes/admin.js` — now a **forward-reference** (unmoved admin importing the cosmetics index), same pattern as `routes/steps.js → modules/ranked`, fine.
- One same-dir require caught by the standing lesson: `queries/getDailyRewardStatus.js` → `./getUnownedAccessoryPool`.

### What moved (all `git mv`, flat, no shim)

`purchaseShopItem.js`, `equipAccessory.js`, `grantLegendCosmetic.js`, `shopCosmetics.js`, `mirrorShopItem.js`, `getShopCatalog.js`, `getUnownedAccessoryPool.js` → `src/modules/cosmetics/`, plus `index.js` exporting the commands/queries/errors, `mirrorShopItemToPeer`, and the spread `shopCosmetics` surface. Consumers updated: `routes/shop.js` (three requires collapsed to one), `routes/admin.js`, ranked's settlement command, the three daily-reward claim commands + `getDailyRewardStatus`, five serializer queries, `modules/leaderboard` + both ranked queries, and `test/utils/shopCosmetics.test.js` (in place). `purchaseShopItem`'s economy edge (`deductCoinsAtomic`) stays an explicit cross-module path until economy moves.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the canonical pre-existing list. Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for all seven old paths.

Next per the Phase 9 order: **admin**.

---

## Phase 9h implementation status (2026-07-21)

Executed the **modules/admin move**, with two disposition rulings the fan-in evidence forced.

### Step 1 findings and dispositions

- **`appSettings` is NOT admin-domain — moved to `shared/config/appSettings.js` instead.** The investigation framed it as admin+auth; the live tree shows **7 src consumers across three domains** (createRace/editRace, createTournament/joinTournamentCore/tournamentSeedRenewal, admin, auth) plus 5 test files — it's the remote-feature-flag service that race/tournament gates consume, merely *operated through* the admin route. Housing it in `modules/admin` would have made competition commands depend on the admin module. All 12 consumers updated to the shared path.
- **`balanceSnapshot`: the † resolves to economy, and it does not move now.** The instruction's premise ("consumers: getAdminStats + scripts") did not hold — `getAdminStats` does **not** import it; its only consumers are the three `scripts/balance-*.js`/`generate-powerups-md.js` scripts (§5's script-only note). It stays in `services/` to travel with `modules/economy`.
- `requireAdmin`: consumed **only** by the admin route — no other route uses it. `adminAccess`: requireAdmin (moves together) + `routes/auth.js` (`isAdminUser`/`withAdminFlag` for the `/auth/me` admin flag) — now a forward-reference via admin's index, same accepted pattern. `mirrorShopItem`: verified already on the 9g `modules/cosmetics` path — nothing stale. `getAdminStats`: admin route + its 3 test files, moves per the 9e ruling.

### What moved (all `git mv`, flat, no shim)

| Old path | New path |
|---|---|
| `src/routes/admin.js` | `src/modules/admin/routes.js` |
| `src/middleware/requireAdmin.js` | `src/modules/admin/requireAdmin.js` |
| `src/services/adminAccess.js` | `src/modules/admin/adminAccess.js` |
| `src/queries/getAdminStats.js` | `src/modules/admin/getAdminStats.js` |
| `src/services/appSettings.js` | `src/shared/config/appSettings.js` *(disposition above)* |
| *(new)* | `src/modules/admin/index.js` — `createAdminRouter`, `isAdminUser`/`withAdminFlag` (auth's edge), `buildRequireAdmin`, `getAdminStats` surface |

Admin's route still imports `balanceConfig` from `services/` (explicit path until economy moves). Consumers updated: `app.js`, `routes/auth.js`, the 7 appSettings consumers, 3 admin-stats tests, 5 appSettings tests, and one prose comment in `scripts/cosmetics-apply.js`.

### Verification

- Unit **1841/0**. Integration **587 / 571 / 16** with one caveat handled transparently: across four post-move full runs, one extra leaf — `open-batch opens all slot boxes + queued overflow in one call` (`powerups-batch-leech-xray.test.js`) — failed in two runs and passed in two, passes **5/5 in isolation**, and has no dependency on any moved file (neither mystery-box command imports appSettings/adminAccess/getAdminStats). Verdict: **order-dependent flake, not a regression** — worth an eventual look alongside the three known-bad files, but unrelated to this move. Final run matches the canonical baseline exactly.
- Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for all five old paths.

Modules complete so far: leaderboard, web, analytics, ranked, cosmetics, admin (+ shared/ fully built). Remaining per the §4 order: users, social, notifications, economy, powerups, steps, then races+tournaments+home together.

---

## Phase 9i implementation status (2026-07-21)

Executed the **modules/users move** — 12 files plus the `deviceToken → shared/push` disposition, the biggest-fan-in module so far.

### Step 1 findings

- File list re-verified: the §2 list held, with the §3 rulings applied — `routes/notifications.js` stays out (notifications module later), `models/deviceToken.js` moved to **`shared/push/deviceToken.js`** (push infrastructure; its 4 consumers — stepSyncPush, notificationHandlers, dailyRewardReminder, notifications route — updated).
- **`models/user.js` had 26 src consumers** — this move's eventBus-equivalent. All now import `{ User }` via the users index.
- `appleSubHash`: consumers are races' `joinRaceCore`/`autoEnrollNewUser` + social's `recordReferral`/`redeemReferralCode` — genuine forward-references via the index (social unmoved), as the investigation predicted.
- The 9h auth↔admin edge survived: `routes.js` (ex-auth.js) now imports `isAdminUser`/`withAdminFlag` via `../admin`.

### What moved (all `git mv`; ranked-style role subdirs)

`routes/auth.js → modules/users/routes.js`; services `ensureAppleUser`, `ensureGoogleUser`, `appleIdentityToken`, `googleIdentityToken`, `sessionToken`, `profilePhotoStorage` → `modules/users/services/`; commands `deleteUserAccount`, `setDisplayName`, `profilePhoto` → `modules/users/commands/`; `models/user.js → modules/users/models/`; `utils/appleSubHash.js → modules/users/appleSubHash.js`; `models/deviceToken.js → shared/push/deviceToken.js`. Consumers updated: `app.js`, `middleware/requireAuth`, 26 User importers, 4 hashAppleSub importers, 4 deviceToken importers, and 10 test/script files.

### The require-cycle lesson (new, recorded for the remaining modules)

The users index is the first whose dependency graph **cycles back into itself**: `index → routes → services (ensureAppleUser) → social/race commands (recordReferral, autoEnrollNewUser) → users index`. Two mitigations, both now in place and applicable to future big modules (economy, powerups, races):
1. `middleware/requireAuth` imports the **concrete files** (`services/sessionToken` etc.), not the index — infrastructure beneath a module must not depend on the module's init order. (First symptom: `instanceof SessionTokenError` exploding with a half-initialized index.)
2. The index populates `module.exports` **incrementally** (`Object.assign` per file, models/services first, **router last**) so mid-cycle consumers see an already-populated exports object instead of the empty one a trailing `module.exports = {...}` would leave them.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the canonical baseline. Stale-reference grep (incl. `require.resolve` and same-dir patterns): **zero hits** for all 14 old paths.

Remaining per the §4 order: social, notifications, economy, powerups, steps, then races+tournaments+home together.

---

## Phase 9j implementation status (2026-07-21)

Executed the **modules/social move** — 20 files (friends, referrals, race chat).

### Step 1 findings and edge confirmations

- File list: §2's 20 files all confirmed on the live tree (`lib/referralCode` had already gone to `shared/lib` in 9b).
- **appleSubHash edge:** all four consumers (social's `recordReferral`/`redeemReferralCode`, races' `joinRaceCore`/`autoEnrollNewUser`) were already on the users **index** from 9i — races keeps that import unchanged; social's two moved with their import intact (depth-adjusted to `../../users`).
- **sharing edge:** `routes/referrals.js` was already on `modules/web`'s index from 9d; inside the module it became `../../web`. Races' and tournaments' route-level sharing imports are untouched.
- **Race chat direction:** confirmed a **forward-reference in the other direction** — `routes/races.js` (races, unmoved) consumes `sendRaceMessage`/`deleteRaceMessage`/`getRaceMessages`, now via social's index. Acceptable: route files are composition points.
- **Require cycle: found, as predicted.** users ⇄ social is mutual: users' sign-in services call `recordReferral`, while social's commands/queries use the users index (`User`, `hashAppleSub`, sessionToken surface). Both 9i mitigations applied: users-side imports of social use **concrete file paths** (`../../social/commands/recordReferral`, `../social/queries/getFriends` — users' router needs `getIncomingFriendRequestCount` during its own init), and social's index populates `module.exports` **incrementally with the two routers last**.
- One same-dir require surfaced *after* the fan-in pass rather than during it: `grantReferralReward.js` → `./awardCoins`, which broke app load until pointed at `../../../commands/awardCoins` (economy, unmoved). Its inbound consumer (`completeRace.js` via `./grantReferralReward`) now imports from social's index.

### What moved (all `git mv`; role subdirs with a two-router `routes/` dir)

`routes/{friends,referrals}.js`, 10 commands (friend lifecycle ×4, referral ×4, race chat ×2), 5 queries, `models/{friendship,raceMessage}.js`, `config/referralRewards.js` (module root) → `src/modules/social/`. External consumers updated: `app.js` (three requires → index), `routes/races.js` (chat trio), `modules/users` (concrete paths), `modules/leaderboard` + `createTournament`/`inviteToRace`/`inviteToTournament` (Friendship via index), `completeRace.js`, and 8 test/script files.

### Verification

- Unit **1841/0**. Integration: leaf-diff shows only the **known 9h flake** (`open-batch opens all slot boxes…`) — same leaf, re-verified **5/5 in isolation**, treated as expected noise per its 9h characterization; the rest of the set is byte-identical to the canonical baseline.
- Stale-reference grep: **zero true hits** for all 20 old paths (the sweep surfaced only the correct new `../social/...` concrete imports and one prose comment, updated).

Remaining per the §4 order: notifications, economy, powerups, steps, then races+tournaments+home together.

---

## Phase 9k implementation status (2026-07-21)

Executed the **modules/notifications move** — 7 files, flat layout. This empties `src/handlers/` (removed).

### Step 1 findings

- File list: §2's seven files all confirmed (`notificationHandlers`, `eventHandlers`, `models/notification`, `notificationCleanup`/`dailyRewardReminder`/`dailyMover` jobs, `routes/notifications.js`).
- **Shared consumption verified clean, not forward-referencing:** `notificationHandlers` consumes `shared/events/eventBus`, `shared/push/{apns,fcm,deviceToken}`, and the users index — all at their final 9c/9i paths. (Its raw-prisma race-model fallbacks remain, as documented since the original audit.)
- **No require cycle.** Notifications is purely downstream: races/tournaments/social producers reach it via `eventBus.emit`, never by import. The complete inbound-caller list: `src/index.js` (handler registration + 3 job schedulers), `app.js` (router), two races-domain jobs reading the `Notification` model (`autoStartScheduledRaces`, `placementRecompute` — now forward-references via the index), and 9 test files. No mitigations needed; the index still populates incrementally with the router last, by convention.
- **routes/notifications.js scope:** prefs + device-token registration only, consuming `shared/push/deviceToken` and the users index — no duplication with what moved to shared/push in 9i (the model lives there; the route consumes it).
- **dailyMover / dailyRewardReminder dependencies:** dailyMover creates two forward-references into unmoved races code (`models/race*`, `services/raceStateResolution`); `dailyRewardReminder`, despite the name, touches **no economy code** (users/deviceToken/notification/eventBus/week only) — no economy forward-reference exists.
- The 9j lesson (same-dir requires *inside* moved files) was applied up front; the post-move smoke-load passed first try.

### What moved (all `git mv`, flat, no shim)

The seven files → `src/modules/notifications/{routes.js, notificationHandlers.js, eventHandlers.js, notification.js, notificationCleanup.js, dailyRewardReminder.js, dailyMover.js}` + `index.js`. `src/handlers/` removed. Consumers updated: `src/index.js` (5 requires → the module index), `app.js`, the two races-domain jobs, one comment in `modules/analytics`, and 9 test files.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the 9j baseline (no flake recurrence this run). Stale-reference grep: zero true hits (one comment referencing the *test* path `test/handlers/…`, which is a real unmoved file — tests stayed in place).

Remaining per the §4 order: **economy, powerups, steps**, then races+tournaments+home together.

---

## Phase 9l implementation status (2026-07-21)

Executed the **modules/economy move** — 20 files — plus one structural disposition.

### The disposition: awardCoins + deductCoinsAtomic → `shared/economy/`, not the module

Fan-in forced it, same logic as appSettings in 9h: `awardCoins` has **24 src consumers** across races, tournaments, social, ranked, steps, and routes; `deductCoinsAtomic` is consumed by powerups, cosmetics — and by **`shared/economy/buyIns.js` itself**, which would have made shared/ depend on a module. They are the cross-cutting ledger primitives, and Phase 5 already established `shared/economy` as the ledger layer — so they now live there (`shared/economy/{awardCoins,deductCoinsAtomic}.js`), and `buyIns.js`'s transitional `../../commands/` import collapsed to `./deductCoinsAtomic`. All 27 src consumers + tests updated.

### Step 1 findings

- File list: §2's 20 files confirmed (openMysteryBox/Batch stay for powerups, claimStepMilestone stays for steps, per the §3 rulings). `balanceSnapshot`'s three script-only consumers held and were updated.
- Same-dir requires inside the moved set (9j lesson, swept up front): the three `claim*` commands' `./claimDailyReward` (intra-module, kept), `./awardCoins`/`./getEligiblePowerupPool`/`./grantPowerupToUser` (cross-module, rewritten — the latter two are powerups-domain forward-references).
- **Cycle avoidance:** powerups-domain consumers of `balanceConfig` (`openMysteryBox`, `usePowerup`, `getEligiblePowerupPool`, `getRaceProgress`, `utils/powerupOdds`, `powerupUpgrades`) and `modules/admin` import it by **concrete path** (`modules/economy/balanceConfig(.defaults)`), not the index — `getEligiblePowerupPool` is itself required by economy's claim commands, so an index import would have cycled.
- Two consumers only the widest sweep caught: **`prisma/seed.js`** (requires `balanceConfig` for the powerup-price seed — outside src/test/scripts, found via a one-test integration regression on the seed-rerun test, fixed) and `test/services/balanceConfigStructuralGuard.test.js`, whose **allowlist pins the balance-table paths** — updated to the new module path (a path update to the guard's exemption list, not a weakening).

### What moved (all `git mv`; role subdirs + root config files)

`routes/{coins,dailyReward,ads}.js`, 5 claim/grant commands, 3 status queries, `balanceConfig.js` + `.defaults.js` + `balanceSnapshot.js`, `dailyBoxOdds.js`, `admobSsv.js`, `adRewards.js`, `constants/dailyReward.js` → `src/modules/economy/`; the two ledger primitives → `src/shared/economy/`. `index.js` populated incrementally, three routers last. Consumers updated: `app.js` (three routes → index), `routes/home.js`, `modules/admin`, the powerups-domain balanceConfig cluster, 24 awardCoins + 3 deductCoinsAtomic importers, `prisma/seed.js`, ~91 test/script files, and three prose comments.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the 9k baseline (after the seed.js fix — the one transient regression this move produced, caught by the leaf-diff). Stale-reference grep across src/test/scripts/**prisma**: zero true hits.

Remaining per the §4 order: **powerups, steps**, then races+tournaments+home together. *Standing lesson added: consumer sweeps must include `prisma/` (seed scripts require src files).*

---

## Phase 9m implementation status (2026-07-21)

Executed the **modules/powerups move** — 28 files, the most cycle-entangled module before the finale.

### Step 1 findings

- File list: §2's 28 files all confirmed (9 commands, 7 models, 5 queries, 4 utils, 2 constants, 1 route).
- **usePowerup error-migration status: NEVER migrated.** Zero `AppError` references — still its own `PowerupUseError extends Error` (line 216) with the ~55 throw sites the original audit flagged as the hardest Phase 2 target. Relocated **as-is**; it remains the one major file still on bespoke errors, and that gap now lives at `modules/powerups/commands/usePowerup.js`.
- usePowerup's sole consumer is `routes/races.js`; it consumes economy at the final 9l paths (concrete `balanceConfig`, `shared/economy/deductCoinsAtomic`) and nothing from cosmetics — no economy/cosmetics cycle.
- Races/tournaments (unmoved) reach into powerups heavily — the three race-effect models alone have 13/10/15 races-domain consumers, plus `racePowerupStateSync → rollPowerup` and the resolution stack's leech/hitchhike/odds imports. All noted as the forward-reference surface the finale move inherits.
- economy's daily-reward cluster: `getEligiblePowerupPool` + `grantPowerupToUser` imports updated from the raw 9l paths to powerups (index).

### The cycle work (this move's hard part)

Pointing races-domain files at the powerups **index** broke the long-documented `getRaceProgress ⇄ raceStateResolution` cycle: the index loads `usePowerup`, which loads `raceStateResolution`, which re-enters a half-initialized `getRaceProgress` (symptom: `computeEffectModifiers is not a function` across 15 scoring tests). A second, subtler chain did the same through the module graph: `completeRace → social index → getRaceMessages → powerups index → usePowerup → raceStateResolution`. Resolution, per the standing concrete-path rule:
- All cycle-adjacent races-domain files (`getRaceProgress`, `raceStateResolution`, `reconcileUploaderRaces`, `completeRace`, `forfeitRace`, `startRace`, `joinRaceCore`, `raceExpiry`, `getRaces`/`getRaceFeed`/`getHomeRaceCard`/`getTournamentsForUser`, `racePowerupStateSync`) import powerups **concrete files** (export-name→file mapped mechanically).
- `modules/social/queries/getRaceMessages` uses concrete powerups model paths; `completeRace` imports `grantReferralReward` concretely rather than via social's whole index.
- Routes and already-moved modules (economy, shop route) use the index — they are top-of-graph.
- Verified both load orders resolve (`getRaceProgress` first and powerups-index first).

### Guard-test path updates (9l pattern, not weakenings)

`test/queries/hitchhikeScoring.test.js`'s structural-parity guard excludes the leech-definition file by path — updated to `modules/powerups/leechTransfers.js`.

### What moved (all `git mv`; role subdirs, utils at module root)

The 28 files → `src/modules/powerups/{routes.js, commands/, models/, queries/, constants/, powerupOdds.js, powerupUpgrades.js, hitchhikeCopies.js, leechTransfers.js}` + incremental `index.js` (models/utils/queries before commands — the ordering the cycle mitigations rely on — router last). ~15 depth-1 src consumers, 6 module-internal consumers, `app.js`, and 68 test/script/prisma files updated.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the 9l baseline (the known flake appeared in the baseline run and is counted there). Stale-reference grep across src/test/scripts/prisma (incl. `require.resolve` and same-dir patterns): **zero true hits**.

Remaining: **steps**, then races+tournaments+home together.

---

## Phase 9n investigation: pre-move plan for the finale (races + tournaments + home) (2026-07-21)

**Investigation only — no files moved.** Everything below was enumerated from the live post-9m tree.

### 0. Ordering caveat: steps has not moved yet

The §4 order puts **steps before the finale**, and it is still unmoved (19 files: steps/stepMilestones routes, record* commands, claimStepMilestone, 4 models incl. globalStepEvent, 4 utils, globalStepEventScheduler job, 3 queries, stepMilestones constants). Five already-moved modules hold raw-path refs into steps (`models/steps` from ranked ×5 and social's getFriends). **Recommendation: run steps as its own 9o pass first** — folding it into the finale would push the single move past 75 files.

### 1. Current file counts (live tree, post-9m)

- **tournaments: 29 files** — 1 route, 13 commands (advanceTournament, cancel/create/forfeit/invite/join×3+Core/kick/leave/respond/start, createTournamentShareLink), 5 queries (getPublicTournaments, getSharedTournamentPreview, getTournament, getTournamentsForUser, serializeTournament), 7 services (tournamentAccess/BuyIns/Errors/Lock/Participants/Rounds/Start), 1 job (tournamentSeedRenewal), `models/tournament`, `constants/tournaments`.
- **races: ~53 files** — `routes/races.js`, 20 commands (the join/invite/kick/leave/cancel/complete/forfeit/create/edit/start families, chat-mute ×2, results-seen, switchRaceTeam, autoEnrollNewUser, autoJoinFeaturedRaces), 10 queries (progress/details/feed/races/featured/public+count/discovery-summary†/shared-preview/homeRaceCard†), 9 services (raceStateResolution, raceBaseline, raceIllusions, raceJoinLock, racePowerupStateSync, reconcileUploaderRaces, validateRaceConfig, withRaceResolutionLock, raceBuyIns), 5 jobs (raceExpiry, raceResolutionQueue, autoStartScheduledRaces, seededRaceRenewal, placementRecompute), 3 models (race, raceParticipant, raceResolutionJob), 5 utils (racePayoutPresets, raceSteps, raceTimeZone — per the 9 §1 ruling it lands here, teamRaces, and contested `boxSteps`), 2 constants (raceFinishReward, teamNames). († = home candidates, below.)
- **home: 3 files** — `routes/home.js` + `getHomeRaceCard.js` + `getRaceDiscoverySummary.js`. Note home's route already imports economy via module paths; its remaining raw refs are `getHomeRaceCard`, `models/globalStepEvent` (steps!), and `getStepMilestonesToday` (steps) — another reason steps moves first.
- **Unassigned leftovers surfaced by this enumeration** (in no §2 module; need dispositions at finale time): `routes/onboarding.js` and `routes/tutorial.js` (thin composition routes — likely stay in `routes/` like `shop.js`, or fold into races/economy respectively — decide then); `routes/appVersion.js` + `config/appVersion.js` + `utils/appVersion.js` (a small app-version surface — candidate `modules/appVersion` or shared); `models/jobRun.js` (cron-dedup infrastructure used by analytics/notifications/ranked/races jobs — candidate `shared/db/jobRun.js`); `utils/shareToken.js` (deferred in 9b; races+tournaments are its only consumers — lands in the finale or shared/lib); `utils/boxSteps.js` (step-box math used by races resolution *and* powerups' hitchhikeCopies — contested, lean powerups or shared); `middleware/{requireAuth,extractTimezone}.js` stay as app middleware; `routes/shop.js` stays a composition router.

### 2. The cycle, exhaustively (current import lines)

**races → tournaments (5 imports in 4 files):**
- `commands/completeRace.js:23` → `./advanceTournament` (`advanceTournament`) — same-dir today, the core edge.
- `commands/completeRace.js:20` → `../constants/tournaments` (`resolveMatchupWinner`).
- `jobs/raceExpiry.js:9` → `../commands/advanceTournament` (`advanceTournament`).
- `queries/getRaceProgress.js:33` → `../constants/tournaments` (`roundLabel`); `:34` → `../services/tournamentAccess` (`isTournamentParticipant`).
- (Composition, not domain: `routes/races.js` → `queries/getTournamentsForUser` for the combined list endpoint.)

**tournaments → races (4 imports in 4 files):**
- `services/tournamentRounds.js:1` → `./raceBaseline` (`snapshotBaselineFields`) — and it creates Race rows via raw prisma.
- `commands/forfeitTournament.js:3` → `./completeRace` (`completeRace`).
- `commands/createTournament.js:15` → `../services/validateRaceConfig` (`validatePowerupConfig`).
- `queries/serializeTournament.js:6` → `../services/raceIllusions` (`collectRaceIllusions`).

(The former `getTournamentsForUser → race models` edge is **gone** — it now points at `modules/powerups` model files since 9m.) Plan of record stays **"keep the cycle, don't fix it"**: after the move these nine imports become cross-module **concrete file paths** (never index-level, per the 9m lesson — an index-level races⇄tournaments edge would re-create the half-initialized-exports failure at scale). Node's partial-exports semantics handle them exactly as today.

### 3. Already-moved modules' raw-path refs INTO races/tournaments — all resolved by the finale

- **powerups →** `services/racePowerupStateSync` (usePowerup, discardPowerup, openMysteryBox), `services/raceStateResolution` (usePowerup), `models/race` (usePowerup, openMysteryBox, redeemPowerupToRace, getRaceInventory), `models/raceParticipant` (usePowerup, expireEffects, openMysteryBox, openMysteryBoxBatch) — the 9m-flagged surface, 14 import lines.
- **social →** `models/race` (sendRaceMessage, deleteRaceMessage, getRaceMessages), `utils/teamRaces` (getFriends).
- **notifications →** `models/race`, `models/raceParticipant`, `services/raceStateResolution` (all dailyMover).
- **users →** `commands/autoJoinFeaturedRaces` (routes.js), `commands/autoEnrollNewUser` (ensureAppleUser, ensureGoogleUser).
- **Not races-domain but same cleanup class:** `models/jobRun` refs from analytics (1), notifications (3), and races jobs — resolved by the jobRun disposition in §1; `models/steps` refs from ranked/social — resolved by the steps move.
- These stay **concrete paths** after the move (all sit inside or adjacent to the resolution/init graph); only top-of-graph consumers (app.js, composition routes) use the new indexes.

### 4. Execution plan for 9o (steps) + 9p (finale)

1. **9o — steps module** (19 files + the 6 module-side `models/steps` ref updates). Also decide `boxSteps` (recommend: powerups, since hitchhikeCopies owns the math's other half) and `globalStepEvent` model/util/job (steps).
2. **9p — races + tournaments + home in one pass**, role subdirs, **two separate indexes** (`modules/races`, `modules/tournaments`) plus tiny `modules/home`; the nine cycle imports and every §3 ref stay concrete. Index construction per the 9i/9m rules: incremental `Object.assign`, models→utils→services→queries→commands→jobs→router, and **nothing inside the resolution stack ever imports an index**. `home` moves last within the pass (it aggregates both).
3. Standing checklist (accumulated 9a–9m lessons): fan-in greps include `require.resolve`, same-dir `./x` requires *in both directions*, and `prisma/`; smoke-load `src/app.js` + both new indexes in both orders before running suites; expect guard-test path pins (`hitchhikeScoring` scans src and will re-discover moved scoring sites automatically — its exclusion list may need the new resolution-stack paths); leaf-diff integration failures against the canonical list (known flake: `open-batch…`); zero-stale grep across src/test/scripts/prisma; `git mv` everything.
4. After 9p: delete the then-empty `src/{commands,queries,services,jobs,routes?,models?,utils?,constants?}` dirs or inventory what legitimately remains (middleware, composition routes, §1 leftovers), and close Phase 9 with a final structure snapshot in this document.

---

## Phase 9n-2 implementation status (2026-07-21)

Executed the **first half of the finale: modules/tournaments** (29 files), leaving the four tournaments→races cycle imports on the old races paths until 9n-3.

### Step 1 findings

- File list confirmed at the 9n counts (1 route, 13 commands, 5 queries, 7 services, 1 job, 1 model, 1 constants).
- **The 9n cycle list missed one races→tournaments consumer:** `queries/getRaceDetails.js` also imports `roundLabel` + `isTournamentParticipant` (same pair as getRaceProgress). Now updated with the rest.
- **No already-moved module imports tournaments at all** — powerups/social/economy/cosmetics/notifications are clean (tournament writes flow through eventBus or raw prisma), so the "resolve forward-references" half of this pass was empty.
- Two consumers only runtime/sweeps caught: `queries/getRaceDiscoverySummary.js` → same-dir `./getPublicTournaments` (9j lesson), and — the painful one — **`app.js` line 218's lazy inline `require("./queries/getSharedTournamentPreview")` inside `createApp`**, invisible to module-load smoke tests because it executes at server construction. It briefly broke every HTTP test (134 unit failures) before the per-file diagnosis found it. *Standing lesson: grep for inline/lazy `require(` sites inside function bodies, and treat "smoke-load passed but HTTP tests fail broadly" as the signature of a lazy require.*

### What moved (all `git mv`; role subdirs)

The 29 files → `src/modules/tournaments/{routes.js, commands/, queries/, services/, models/, jobs/, constants/}` + incremental `index.js` (model→constants→services→queries→commands→job, router last). Consumers updated: `app.js` (router + the lazy preview require), `src/index.js` (seed-renewal scheduler via index), the six races-domain files (`completeRace`, `raceExpiry`, `getRaceProgress`, `getRaceDetails`, `routes/races.js`, `getRaceDiscoverySummary`) → **concrete** `modules/tournaments/...` paths per the cycle rule, and 5 test files.

### The four tournaments→races imports still on OLD paths (updated in 9n-3)

| File | Import |
|---|---|
| `modules/tournaments/services/tournamentRounds.js:1` | `../../../services/raceBaseline` (`snapshotBaselineFields`) |
| `modules/tournaments/commands/forfeitTournament.js:3` | `../../../commands/completeRace` (`completeRace`) |
| `modules/tournaments/commands/createTournament.js:15` | `../../../services/validateRaceConfig` (`validatePowerupConfig`) |
| `modules/tournaments/queries/serializeTournament.js:6` | `../../../services/raceIllusions` (`collectRaceIllusions`) |

Verified working as-is (races files unmoved, old paths valid — the passing suites are the proof), and each carries the index-comment explaining why it stays concrete.

### Verification

Unit **1841/0**; integration **leaf-failure set diffed byte-identical** to the 9m baseline (after the lazy-require fix). Stale-reference grep across src/test/scripts/prisma: **zero hits** for all 29 old paths.

Remaining: **9o steps**, then **9n-3/9p: races + home**, which also flips the four imports above to `modules/races` concrete paths.

---

## Client investigation: /auth/me 5xx on shipped builds (2026-07-21)

Investigation of Phase 1 flag #2 — what a shipped iOS binary does when `GET /auth/me` returns 500. The client **is** the Flutter repo (`stepv2-frontend`, ships both iOS and Android); it was traced directly. Read-only; no code changes.

**Verdict: safe.** On a `/auth/me` 5xx — at launch or on resume — a shipped build (1.6.6) does not log out, does not error, does not crash: the error is swallowed and the app keeps running on the cached user. No version gating is needed for the Phase 1 change.

Evidence (frontend repo paths):

- `fetchMe` (`lib/services/backend_api_service.dart:615-629`) throws `ApiException(statusCode)` for any non-2xx via `_decodeJsonResponse` (:2816-2843). No retry.
- **Cold start can't be affected:** the `MainShell` vs `StartScreen` decision (`lib/main.dart:245-276`) uses `restoreSession()` (`lib/services/auth_service.dart:184-227`), which reads only `SharedPreferences` — no network call.
- **The only logout gate is `POST /auth/session`, and only on 401:** `_refreshSessionToken` (`lib/screens/main_shell.dart:634-670`) signs out only when `isAuthenticationFailure(error)` — defined as `statusCode == 401` exactly (`auth_service.dart:47-49`, its sole call site). Any 5xx/timeout from `/auth/session` keeps the session (`main_shell.dart:668`).
- **`/auth/me` errors are swallowed everywhere:** the launch/resume fetch `_refreshMe` (`main_shell.dart:2019-2045`) wraps the whole call in `catch (_) {}`; the resume path (`didChangeAppLifecycleState`, `main_shell.dart:577-590`) never even calls the session refresh. All other `fetchMe` call sites (create-race, public-races, tournament-detail, race-detail wallet refresh) are inside their own catch blocks; none sign out. Even a 401 from `/auth/me` is swallowed.
- **Cached fallback:** `syncFromBackendUser` (`auth_service.dart:552+`) persists user fields to `SharedPreferences`; on failure the last-synced values simply remain.
- **History:** the 401-only logic dates to commit `a54c019` (2026-03-16), well before the shipped 1.6.x builds, so frozen binaries carry exactly this behavior.

Backend-side note (if this ever needs revisiting): every request already carries `X-App-Version` with fail-open `parseVersion`/`compareVersions` helpers (`src/utils/appVersion.js`) plus the `X-Client-Features` capability header — either could make an error-behavior change conditional on client version without a new mechanism.

---

## Phase 9o implementation status (2026-07-21)

Executed the **modules/steps move** — 19 files — per the 9n §4 order (steps before the finale), plus the contested-file disposition: **`utils/boxSteps.js` → `modules/powerups/boxSteps.js`** (hitchhikeCopies owns the other half of the box-step math; consumers are the races resolution stack + powerups tests/scripts).

### Step 1 findings

- File list confirmed at 19 (2 routes, 4 commands, 4 models, 3 utils, 3 queries, 1 job, 1 constants — plus boxSteps to powerups). `globalStepEvent` model/util/job all landed in steps per the 9n recommendation.
- The steps ⇄ races cycle is real and bidirectional: `recordSteps`/`recordStepSamples` → `raceStateResolution`/`racePowerupStateSync` (races services), while the races resolution stack imports `models/steps`, `models/stepSample`, `models/globalStepEvent`. All cross-domain refs stay **concrete paths**; only `app.js` and `src/index.js` use the new index.
- One function-body lazy require existed *inside* a moved file (`recordStepSyncV2.js:234` → `../models/stepSample`) — internal to the module, path shape unchanged after the move, verified.
- Module-side raw refs resolved: ranked ×5, social `getFriends`, tournaments `tournamentRounds` (`../../../models/steps` → `../../steps/models/steps`).

### What moved (all `git mv`; role subdirs, utils at module root)

The 19 files → `src/modules/steps/{routes/, commands/, models/, queries/, jobs/, constants/, streak.js, stepSyncCanonical.js, globalStepEvent.js}` + incremental `index.js` (models → utils → queries → commands → jobs → routers LAST). `boxSteps.js` → `src/modules/powerups/boxSteps.js`. Consumers updated: 10 depth-1 src files (races domain + `routes/home.js`), 7 module-side files, `app.js`, `src/index.js`, ~25 test files, 3 scripts, 3 prose comments.

### Verification

Unit **1841/0 → 1841/0**; integration leaf-failure set **identical to the fresh 9o baseline** except the documented `open-batch…` order-dependent flake, which passes **5/5 in isolation** (run with the runner's own flags — bare `node --test` on one integration file hangs on open DB handles; use `--test-concurrency=1 --test-force-exit` + the integration `DATABASE_URL`). Smoke-load green in all three load orders (app-first, index-first, `getRaceProgress`-first). Zero stale references across src/test/scripts/prisma.

Remaining: **9p — races + tournaments-import flip + home**, the finale.

---

## Phase 9p implementation status — the finale: modules/races + modules/home (2026-07-21)

Executed the **last move of Phase 9**: `modules/races` (52 files), `modules/home` (2 files + index), `models/jobRun.js → shared/db/jobRun.js`, `utils/shareToken.js → shared/lib/shareToken.js`, and the **flip of the four tournaments→races imports** documented in 9n-2 to `modules/races` concrete paths.

### Step 1 findings / dispositions

- **`getRaceDiscoverySummary` landed in `modules/races/queries/`, not home** — deviation from the 9n candidate list, evidence-based: its only consumer is the races route (`routes.js:64`, the Races-tab discovery endpoint). `modules/home` is therefore just `routes.js` + `getHomeRaceCard.js`.
- **jobRun's consumers are notifications ×3 + analytics ×1 only** (no races jobs — the 9n note was stale). Moved to `shared/db/jobRun.js` as cron-dedup infrastructure.
- shareToken consumers: races `createRaceShareLink` + tournaments ×3 → `shared/lib/shareToken.js`.
- One function-body lazy require inside a moved file (`getRaceProgress.js:818` → `./raceStateResolution` after move) — internal, shape-preserved.
- `routes/races.js` consumes `modules/web`'s `.sharing` namespace and five module indexes (powerups/social/users/web/tournaments-concrete) — all fine at top-of-graph.
- **Leftovers intentionally staying outside modules/**: `routes/{shop,onboarding,tutorial,appVersion}.js` (thin composition routes), `config/appVersion.js` + `utils/appVersion.js` (app-version surface), `middleware/{requireAuth,extractTimezone}.js`, `db.js`, `peerDb.js`.

### The latent users-cycle hazard found (and hardened)

Smoke-loading `modules/home` standalone surfaced a **pre-existing** half-initialization hazard, invisible through app.js (which loads the users index first): `requireAuth → users/services/ensureAppleUser → social/commands/recordReferral → users INDEX` and `…ensureAppleUser → races/commands/autoEnrollNewUser → users INDEX`. In that order, `recordReferral`/`ensureAppleUser`/`buildRequireAuth` are destructured from half-initialized modules (captured `undefined` — a real runtime break in any entrypoint that loads `requireAuth` before the users index). Both offending files imported the users **index** from inside the cycle — a violation of the standing concrete-path rule predating this phase. Hardened per the 9i/9m pattern: `recordReferral` and `autoEnrollNewUser` now import `users/models/user` + `users/appleSubHash` concretely. All smoke orders now load warning-free.

### What moved (all `git mv`)

Races: 1 route → `modules/races/routes.js`, 20 commands, 9 queries (incl. discovery-summary), 9 services, 5 jobs, 3 models, 2 constants, 4 root utils + incremental `index.js` (models → utils → constants → services → queries → commands → jobs → router LAST; header comment documents the three concrete-path cycles). Home: `routes.js` + `getHomeRaceCard.js` + index. Consumers updated: tournaments (4 flips + 3 shareToken), powerups ×7 files, social ×4, steps ×6, notifications ×3 (+3 jobRun), analytics (jobRun), users ×3, `app.js`, `src/index.js`, ~104 test/script files. Empty `src/{commands,queries,services,jobs,models,constants}` dirs removed.

### Verification

Unit **1841/0 → 1841/0**; integration leaf-failure set **byte-identical** to the 9o baseline (diffed; the known flake did not fire). Smoke-load warning-clean in seven orders (app-first, races-first, powerups-first, tournaments-first, steps-first, home-first, `getRaceProgress`-first). Zero stale references across src/test/scripts/prisma.

### Closing structure snapshot — Phase 9 complete

```
src/
  app.js  index.js  db.js  peerDb.js
  config/appVersion.js          # app-version surface (with routes/ + utils/ pieces)
  middleware/{requireAuth,extractTimezone}.js
  routes/{shop,onboarding,tutorial,appVersion}.js   # thin composition routes
  utils/appVersion.js
  shared/
    competition/lifecycle.js    config/appSettings.js
    db/{withAdvisoryLock,jobRun}.js
    economy/{awardCoins,deductCoinsAtomic,buyIns}.js
    errors/AppError.js          events/eventBus.js
    http/{errorMiddleware,asyncHandler}.js
    lib/{profanity,displayNameValidator,referralCode,shareToken}.js
    middleware/{clientFeatures,releaseChannel}.js
    push/{apns,fcm,stepSyncPush,deviceToken}.js
    time/{week,etSchedule}.js
  modules/
    admin  analytics  cosmetics  economy  home  leaderboard  notifications
    powerups  races  ranked  social  steps  tournaments  users  web
```

All 15 modules use the same shape: role subdirs (or flat when small), utils at module root, incremental `Object.assign` index with the router last, cross-module cycle edges always concrete file paths. The §6 target structure is now the actual structure; remaining §1/§2 gaps (usePowerup's bespoke errors, the three known-bad test files, the open-batch flake) are tracked above and unchanged by Phase 9.
