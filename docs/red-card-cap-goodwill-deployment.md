# Red Card cap and Soch goodwill operation

Status: prepared for production approval. An exact SELECT-only production
lookup verified Soch on 2026-09-10; the canonical ID and lookup evidence are
recorded in gitignored `CLAUDE.local.md`. No copy write, coin grant, restart, or
deployment has been performed for this batch.

## Backend change

Every new Red Card activation removes the rounded 10% of its final recipient's
race score, at most 10,000 steps. Mirror/Decoy resolve first. The existing atomic
penalty helper still caps the result to available score; result.penalty, durable
powerup events, direct impact records, and public feed all retain that actual
amount. One live use route invokes the shared command for every client version.
Historical replay continues using stored metadata.penalty, including older losses
above 10,000. Each distinct activation has its own cap.

No schema migration, backfill, feature flag, new request/response field, or
additional database operation is introduced. Existing notification wording is
nonnumeric and remains correct. Backend deploy precedes the paired mobile release.

## Copy deployment (after separate production authorization)

1. Follow the repository deployment runbook to deploy the verified backend
   revision. Retain exactly two production PM2 workers and leave staging stopped.
2. In the deployment environment with DATABASE_URL intentionally set to the
   production database, preview `node scripts/powerup-copy-sync.js`.
3. Inspect every previewed change. This script synchronizes the complete canonical
   PowerupCopy seed, not just Red Card; do not apply unexpected unrelated drift.
   Never run the full Prisma seed for this copy change.
4. Apply the reviewed copy diff with `node scripts/powerup-copy-sync.js --apply`.
   This is a separately authorized production write. Red Card's description is:
   `Remove 10% of the leader's steps, up to 10,000 steps.`
5. Verify authenticated current and supported legacy GET `/powerups/catalog`
   responses carry that description. The catalog has a 60-second cache; allow
   its existing TTL to expire if needed. No new invalidation mechanism is needed.
6. Observe normal production health without executing attack or integration-test
   fixtures against production. Do not alter existing race results to test the cap.

## One-time goodwill gift (after separate production-write authorization)

Amount: **+500 coins**. Ledger reason: **admin_grant**. Immutable incident reference:
**red-card-goodwill-2026-09-10**. Human reason: Red Card goodwill compensation for
Soch. This is not a step reversal or ongoing reimbursement policy.

The existing `scripts/grant-coins-manual.js` invokes `awardCoins`, which creates
one CoinTransaction and atomically increments the current wallet balance. The
unique `(userId, reason, refId)` ledger key protects retries and concurrent calls;
wallet cache invalidation runs afterward. This path does **not** emit a push,
email, inbox notification, or other user correspondence. No message is authorized.

1. Use the verified canonical ID from the local operations handoff. For initial
   identity verification (already completed for this batch), the exact,
   case-sensitive bounded lookup is:

   ```sql
   SELECT id, display_name, coins FROM users WHERE display_name = 'Soch' LIMIT 2;
   ```

   `User.displayName` is unique. Require exactly one exact match. If no exact
   match exists, resolve identity before any credit; do not substitute a similar
   display name. Save the immutable returned ID as `SOCH_USER_ID` in the
   operator's session and in the restricted operation record. Do not commit
   personal account details to this repository.

2. With psql `--set=soch_user_id="$SOCH_USER_ID"`, inspect the durable ledger:

   ```sql
   SELECT id, user_id, amount, reason, ref_id, created_at
   FROM coin_transactions
   WHERE user_id = :'soch_user_id'
     AND reason = 'admin_grant'
     AND ref_id = 'red-card-goodwill-2026-09-10'
   LIMIT 2;
   ```

   If one matching entry exists with amount 500, the operation is complete;
   verify balance/history and do not grant again. If it has any other amount,
   stop and investigate. A matching reference with the wrong amount must not be
   treated as success merely because the grant script would skip it.

3. Preview, keeping the same canonical ID and reference on every attempt:

   ```sh
   node scripts/grant-coins-manual.js --user "$SOCH_USER_ID" --amount 500 --ref red-card-goodwill-2026-09-10
   ```

   Check exact username/ID, +500, reason and reference. This command is read-only.
   DATABASE_URL must be deliberately set in the authorized operator environment;
   do not paste database credentials into chat or committed files.

4. Apply once:

   ```sh
   node scripts/grant-coins-manual.js --user "$SOCH_USER_ID" --amount 500 --ref red-card-goodwill-2026-09-10 --apply
   ```

5. Repeat the ledger SELECT and require exactly one +500 entry. Verify the wallet
   using the immutable ID (the same psql variable):

   ```sql
   SELECT id, display_name, coins FROM users WHERE id = :'soch_user_id';
   ```

   Compare the current balance with the preview balance plus 500, accounting for other legitimate ledger transactions
   after the preview; concurrent spending/earning can change the final balance.
   Record user ID, ledger ID, +500, reference, operation time, and verified outcome
   in the restricted operation record. Do not expose unrelated account data.
6. On a timeout, inspect the durable ledger before retrying. Never choose a new
   reference or resolve the username again to a potentially different account.
   Keep all historical race steps and prior Red Card records unchanged.

## Verification evidence

- `test/integration/red-card-cap.test.js`: real HTTP use, public progress/feed,
  durable penalty/impact conservation, rounding/cap boundary, current/legacy
  requests, Mirror/Decoy/Socks, low-score concurrency, retry protection, per-use
  cap, team aggregation, actual copy-sync CLI/catalog, and a separately spawned
  production worker preserving a historical 20,000-step penalty.
- Tests-first evidence: before the cap, 7 of the initial 21 cases failed exactly
  on oversized deductions (including 100,005 rounding to 10,001); the copy test
  also failed on the old uncapped description. Production logic then changed.
- `test/integration/manual-coin-grant.test.js`: invokes the existing grant CLI
  against a local fixture; preview leaves the wallet untouched, concurrent
  retries create one +500 ledger row, legacy `/auth/me` reports the incremented
  balance, and no inbox alert is created.
- All write-based tests use verified localhost `steps-tracker-integration_test`;
  no automated test runs against Soch or production.
- Runtime hot-path cost: one scalar clamp, **zero added SELECTs, writes, queue
  jobs, locks, or per-user loops**. This is a source audit, not a load benchmark.

### Verification run on 2026-09-10

| Check | Result |
|---|---|
| Full `npm run test:unit` | 3,391 passed, zero failures |
| New Red Card HTTP suite | 23 passed, both standalone and inside the full integration run |
| Existing manual coin-grant CLI verification | 1 passed, standalone and inside full integration run |
| `npm run powerups:docs:check` | Passed |
| Full `npm run test:integration` | 3,210 passed, 92 failed, 1 existing skipped test (3,303 total) |
| Untouched baseline `68da3a1`, only the 40 initially failing files | 403 passed, 89 failed (492 total) |

The full integration suite remains red. Comparison against the untouched
baseline and additional isolated diagnostics reproduced **88 of the original
92 failures on the baseline**. The other **4 original failures passed on the
changed checkout**, including the 2,000-write burst after providing its required
local Redis URL. Some existing queue-selection and asynchronous event-count tests
vary between runs; the isolated baseline diagnostics reproduce their failures.
No existing assertion was weakened, skipped, deleted, or rewritten for this
change, and no unrelated business-logic repair was attempted.

The cap-specific new tests, existing Red Card/defense tests, and full unit suite
are green. Code review returned SHIP with no findings for the backend scope.
These results do not claim a clean full integration suite or authorize production
deployment. All three disposable Redis instances used for diagnostics are local,
with persistence disabled, and are stopped after verification.
