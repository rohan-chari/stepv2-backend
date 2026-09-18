# Unit Suite Cleanup Audit

Branch: `performance/scalability`

## Why this cleanup was needed

The old `npm run test:unit` command was not a true unit suite. It recursively swept ten source-oriented test folders and therefore mixed pure unit tests with HTTP behavior, worker/scheduler reliability, startup contracts, load/performance evidence, migration checks, and retired rollout coverage.

Before this cleanup, the default unit command owned **502 test files**.

## Result

The default unit gate now owns **326 test files**, down from 502.

- **167 tests moved** to an existing non-unit suite.
- **9 obsolete tests deleted**.
- **0 production files changed** by this cleanup.
- Tests were moved without changing their directory depth when relative imports depend on `../../src`.

That is a **35% reduction** in the default unit-file inventory before consolidating any duplicate current-domain tests.

## Current default unit ownership

`npm run test:unit` now runs only:

- `test/commands/**/*.test.js`
- `test/lib/**/*.test.js`
- `test/modules/**/*.test.js`
- `test/queries/**/*.test.js`
- `test/services/**/*.test.js`
- `test/utils/**/*.test.js`

The following categories no longer belong to the default unit gate.

### MOVE: HTTP behavior

All former `test/http/*.test.js` files moved into `test/http-and-service/`.

Reason: route/auth/request/response behavior is already owned by `npm run test:http-service`.

### MOVE: startup and architecture contracts

Former `test/startup/*.test.js` plus PM2/runtime/structural inventory checks moved into `test/contracts/`.

Examples:

- PM2 topology guard
- database-pool startup configuration
- production Prisma query-event guard
- process-role startup ownership
- runtime-control manifest
- race write-fence inventory
- scoring-input version inventory
- notification-domain isolation structural checks

Reason: these protect deployment/runtime architecture contracts, not isolated business logic.

### MOVE: jobs and handlers

All former `test/jobs/*.test.js` and `test/handlers/*.test.js` files moved into `test/reliability/`.

Reason: timers, worker wakeups, scheduler ownership, retries, notification handlers, queue drain behavior, and asynchronous orchestration are reliability concerns.

### MOVE: performance and load evidence

The following moved into `test/performance/`:

- old `test/lib/perf/**`
- old `test/modules/loadTesting/**`
- capacity tests
- cache-efficiency tests
- DB/pool telemetry tests
- event-surge telemetry tests
- Redis memory/load evidence
- coordinated optimization metrics
- race powerup performance
- race-resolution work-budget evidence
- other explicitly performance-shaped service tests

Reason: these should not block the fast business-logic unit gate.

### MOVE: migration-only checks

Service tests whose permanent purpose is validating a migration/cutover artifact moved into `test/maintenance/`.

Reason: one-time schema transition checks are valuable, but they are maintenance coverage rather than unit behavior.

## DELETE: confirmed retired coverage

The following tests were removed rather than repaired or relocated because they validate retired product paths or one-time rollout scaffolding:

- `test/commands/editRaceBuyIn.test.js`
- `test/commands/fannyPack.test.js`
- `test/services/raceBuyIns.maxAmount.test.js`
- `test/services/tournamentBuyIns.test.js`
- `test/commands/recap-cutover-operator.test.js`
- `test/services/featureControlRemediation.test.js`
- `test/services/remainingFeatureControlCleanup.test.js`
- `test/services/simpleEventRecapRetirement.test.js`
- `test/services/featureBatch20260726Powers.test.js`

The cleanup deliberately did **not** delete ambiguous tests merely because they have old-looking names. Current gameplay compatibility coverage stays until the underlying production path is conclusively retired.

## What stays in unit

The default unit suite is intended to protect:

- deterministic gameplay rules
- command validation/state-transition logic with injected dependencies
- scoring and payout calculations
- powerup behavior
- query shaping and serialization
- pure configuration normalization
- small service functions that do not require real Postgres/Redis/process lifecycle behavior
- utility functions

## Ownership rule going forward

A test should not be added to `test:unit` if its primary assertion depends on:

- a real HTTP server
- Postgres schema/migration state
- Redis availability or queue recovery
- process roles / PM2 topology
- timers or long-running worker ownership
- query-count/load/memory thresholds
- deployment cutovers
- retired feature flags

Use `test:http-service`, `test:contracts`, `test:reliability`, `test:performance`, `test:maintenance`, or `test:integration` instead.

## Next cleanup phase

The remaining 326 files are much closer to true domain-unit coverage. A later consolidation pass can still merge narrow duplicate files, especially around powerup command variants, race-progress query variants, and scoring-service implementation details. That should be done by preserving enduring domain assertions rather than deleting by filename pattern.
