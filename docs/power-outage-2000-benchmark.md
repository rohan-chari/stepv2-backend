# Power Outage: 2,000-recipient integration benchmark

Measured locally on 2026-09-08. Implementation is prepared locally, not deployed.

## Result

Final fixture: one caster plus 2,000 accepted recipients in an active seven-day,
time-based race. Both implementations affect exactly 1,025 recipients.

| Measurement | Original implementation | Batched implementation |
| --- | ---: | ---: |
| HTTP request, run 1 | 3,137 ms | 342 ms |
| HTTP request, run 2 | 3,280 ms | 320 ms |
| HTTP request, run 3 | 3,314 ms | 323 ms |
| Median HTTP request | **3,280 ms** | **323 ms** |
| SQL statements per request | **15,974** | **56** |
| Affected recipients, every run | 1,025 | 1,025 |

The final weekly fixture's median is **10.2× faster**, a **90.2% reduction** in
request time and **99.65% fewer SQL statements**. An earlier target-based fixture
on the same machine measured 2,425–2,460 ms before and 301–327 ms after (8.2× median
speedup). Local machine load and fixture shape affect timings; these results are
not a production latency guarantee or a measurement of database CPU savings.

## Method

- Test: `test/integration/power-outage-2000.test.js`.
- Real authenticated HTTP POST to `/races/:raceId/powerups/:powerupId/use`, real
  Express handler, production command/transaction, PostgreSQL writes, durable
  outbox/audiences/receipts, and response serialization.
- Fresh fixtures before every run; setup and subsequent assertions are excluded
  from request timing. No parallel benchmark runs against the test database.
- Dedicated local database `steps_outage_2000_test`, PostgreSQL 16.14, Node 24.16.0.
  Test guards require localhost and a database name ending in `_test`.
- Defense assignment uses seed `20002026`. Decoy draws use seed `20260908`.
  The test temporarily substitutes the RNG while loading the command, then
  restores global `Math.random`; no command/model collaborator is replaced and
  no lightweight injected transaction path is used.
- SQL is observed with Prisma query events during the measured HTTP request.
  The regression assertion is at most 250 statements, rather than a flaky
  machine-dependent wall-clock threshold.
- The baseline test was written and run before business-logic changes. Outcome
  assertions passed; the SQL-budget assertion failed at approximately 16,000
  statements. The rollback test also passed against the original implementation.
- For the final repeatable comparison, an isolated copy of the working source
  restored only the three modified production files from commit `83a8fe0`.
  Other existing working-tree changes, test code, schema and database were held
  constant. No production data or service was touched.

Fixture recipients:

| Defense state | Count |
| --- | ---: |
| None | 803 |
| Umbrella | 198 |
| Compression Socks | 203 |
| Umbrella and Compression Socks | 189 |
| Decoy | 211 |
| Expired Compression Socks | 202 |
| Existing Power Outage | 194 |

The caster also has Stealth Mode to check persisted attribution and notification
privacy. These are test-fixture distributions, not game drop rates.

## Implementation

The existing race fence, race/item/participant locks, transaction deadline and
atomic commit are retained. Inside that transaction:

1. Fetch active effects for the accepted roster once, including teammates who
   can be Decoy redirect destinations.
2. Resolve Decoys and final landing defenses in memory, retaining destination
   deduplication and Umbrella → existing Outage → Socks precedence.
3. Bulk-update consumed Decoys and Socks; bulk-insert shield feed events and
   outage effects. Capture caster boundary metadata once for the cast. Effect
   and feed inserts use batches of up to 500 rows.
4. Use the existing bulk domain-event append path to preserve individual
   immutable events, recipient audiences and final receipts.
5. Consume the held powerup and commit everything together. Cache invalidations
   and legacy event hints still run after commit. Shield-feed invalidation is
   coalesced to the newest durable marker for the batch.

There are no new client fields, required parameters, migrations, or release
controls. Older-client effect downcasting remains intact. iOS and Android both
benefit from the shared backend change without an app update. The existing
30-second race-progress polling interval is a separate display-latency issue;
this benchmark measures the use request, not the time every device shows it or
the time push notifications arrive. It also does not simulate production lock
contention or the background race-resolution/notification workers.

## Validation

- New suite: **4/4 pass** — three full 2,000-recipient runs and one database-trigger
  failure at final item consumption proving effects, consumed defenses, feed
  rows and durable events/receipts all roll back.
- Checks every affected recipient, fixed seeded outcome count, shared start
  time and exact duration, immunity, consumed/expired defenses, existing outage
  windows, stealth metadata, durable recipient events/receipts and actual HTTP
  rejection of an affected recipient's subsequent powerup attempt.
- Existing focused integrations: **73/75 pass** across Decoy concurrency and
  redirection, wave 5, Signal Jammer, stealth push anonymity and attack push
  durations. All Power Outage and Decoy cases pass.
- Two existing failures also reproduce with the original production files:
  `powerups5-wave.test.js` — “catalog exposes wave 5 only to capable clients and
  omits retired Imposter” (DECOY missing) and “penalizes the target at expiry when
  the goal is missed” (Drill Sergeant penalty is 0, expected -1500). Assertions
  were left intact; the broader suite is not entirely green.
- Existing command tests: **67/67 pass** (`usePowerup`, `usePowerup.upgrades`,
  `powerups`).
- Frontend `flutter analyze`: clean. No frontend changes; mobile builds and the
  full backend/frontend test suites were not run for this backend-only change.
- Required code review: no blockers or issues, including a follow-up review of
  deterministic benchmark RNG handling.

To rerun against a migrated, dedicated local test database:

```sh
DATABASE_URL=postgresql://localhost:5432/steps_outage_2000_test \
NODE_ENV=test \
REFERRAL_IP_HMAC_ACTIVE_VERSION=1 \
REFERRAL_IP_HMAC_SECRET_V1=integration-test-only-referral-hmac-secret-material \
node --test --test-concurrency=1 --test-force-exit test/integration/power-outage-2000.test.js
```
