# Powerup participant-lock scope

Work started 2026-09-08 from production release `3b241ff` in an isolated checkout.
The user authorized TDD for locking fixes. Queue implementation, post-commit
restructuring and production deployment are outside this change.

## Problem and safety boundary

The common powerup-use transaction acquired every accepted participant row.
This broad fallback originated in `4640c369` (August 20) to cover defense-dependent
attack destinations and preserve ordered locking. `dd32206d` (August 23) narrowed
Pinecone Toss only in source intent. Real-database tests uncovered that the raw
query returns lowercase enum values while that old branch compares uppercase
`PINECONE_TOSS`, so its advertised optimization was dormant in production. Do not
treat the comment or uppercase unit doubles as proof of narrower live locking.
Self-only bonuses inherited the broad scope intended for fanout and reflection.

The race write fence and lifecycle lock remain necessary. Narrower participant
locks reduce row-lock work and waits on unrelated participant writers; they do
not make same-race powerup commands execute concurrently. Reading an eligible
recipient list does not itself require locking every member of that list.

Mirror/Decoy routing can touch three participants: caster, original Decoy holder,
and redirected recipient. The affected set must include consumed defenses, not
just the final recipient. Planning must not consume defenses or charge coins,
and must preserve the existing random choice when applying the command.

## Validation record

On unchanged release code, the new HTTP/database lock-scope suite ran 27 tests:
21 lock-scope assertions failed and six existing-behavior safety assertions passed.
Each failure observed `pg_blocking_pids` pointing to the broad accepted-participant
`SELECT ... FOR UPDATE`, not just an arbitrary timing threshold. A deliberate
500ms hold prolonged the pending command until the unrelated row was released.
The test samples authoritative inventory consumption independently of HTTP
completion, because callbacks can continue after commit.

Three additional real-HTTP tests passed on unchanged code: an Outage is first
observed owning the race fence while waiting for a participant; a following
Protein Shake, Trail Mix or Shortcut is then observed waiting on that Outage's
race-job fence. After release, Outage succeeds and the following use returns 409
jammed, with its item HELD and no bonus or use event. This guards required race
ordering while participant locks are narrowed.

Tests run only on dedicated localhost `steps_powerup_locks_test` and
`steps_powerup_lock_fence_test`. Baseline logs are `/tmp/powerup-locks-before.log`
and `/tmp/powerup-lock-fence-before.log`.

Additional tests were written before subsequent fixes: race expiry while waiting,
unused Socks on a Decoy fizzle, a duplicate-validation-only effect, and an unrelated
effect held by another writer. Four assertions failed in the intermediate patch
and then passed after narrowing effect dependencies and rechecking the deadline.
The final 33-test lock suite also covers changed target totals, expiring Decoy,
same random draw across a replan, duplicate use, jam expiry and defense races.

## Implemented scope

- Self participant only: Protein Shake, Trail Mix, Runner's High, Stealth Mode,
  Compression Socks, Mirror, Umbrella, Decoy and Campfire Rest.
- Planned target set: Shortcut, Detour Sign and Signal Jammer. Resolve the
  defense chain without writes, lock participants by user ID, lock only defense
  rows the chain can consume, and revalidate before applying. If dependencies
  changed while waiting, retry from a new transaction with the same random draw.
  After two changed plans, use the previous conservative cohort path. Retries
  share the existing 30-second execution budget; no new client error is added.
- Other types retain their existing behavior and broader locks. This includes
  complex scorer-boundary, rank, inventory-transfer and race-wide paths. The old
  dormant Pinecone special case is not silently enabled by this change.

No post-commit callbacks were removed or rescheduled. No API shape, game values,
random-outcome distribution, schema or runtime configuration changed. Frozen
clients continue receiving the completed result through the same endpoint.

## Before/after measurements

[Raw samples and environment](powerup-lock-scope-results.json) preserve all
measurements, including warmup. Local Node 24.16.0 / PostgreSQL 16.14; one HTTP
process, no resolution worker. These are focused lock/HTTP experiments, not the
larger concurrent step-sync capacity comparison described in the research spec.

Across 21 synthetic lock cases, baseline effects committed only after releasing
the unrelated row; every revised case committed while the row remained locked.
Median HTTP completion was 555.8 ms before and 28.0 ms after. The intentional
500ms hold explains that difference: it proves removal of a lock dependency,
not a 20x production speedup. First-observed commit ranges were 550.4–618.6 ms
before and 32.6–77.3 ms after; polling makes these upper-bound observations.

Uncontended comparison: one warmup plus three measured rounds per type at each
race size, identical operation order, setup excluded. Median HTTP times:

| Participants | Powerup | Before ms | After ms | SQL before → after |
| ---: | --- | ---: | ---: | ---: |
| 4 | Protein Shake | 9.52 | 9.58 | 32 → 32 |
| 4 | Trail Mix | 8.71 | 9.08 | 33 → 33 |
| 4 | Shortcut | 10.59 | 12.34 | 38 → 46 |
| 2000 | Protein Shake | 17.77 | 15.58 | 32 → 32 |
| 2000 | Trail Mix | 18.37 | 17.11 | 33 → 33 |
| 2000 | Shortcut | 19.91 | 19.88 | 38 → 46 |

Target planning adds eight statements on the no-defense Shortcut path. Its
uncontended small-race request was slower in this sweep, while the 2,000-player
case was effectively unchanged. Three sequential samples do not establish
statistical significance or production performance. The retained race fence
still serializes concurrent casts; database CPU and sustained throughput were
not measured. Do not represent this result as the queue comparison.

## Completed verification

- 157 integration tests passed: 33 new lock tests plus 119 existing relevant
  integration cases, three race-fence ordering tests, and two uncontended cost
  fixtures (each issues twelve real powerup requests).
- 73 focused existing command/helper tests passed.
- Required code reviewer found no remaining blockers; the new effect-lock
  dependency findings were fixed before approval.
- `git diff --check` passed. Full backend integration/unit suites were not run;
  testing focused on the changed types, shared defense paths and concurrency.

Logs: `/tmp/powerup-locks-dependencies-red.log`,
`/tmp/powerup-locks-regressions.log`, `/tmp/powerup-locks-command-tests.log`,
`/tmp/powerup-lock-cost-before.log`, `/tmp/powerup-lock-cost-after.log`.

To reproduce the parent comparison fixtures against a separately migrated local
test database (set `DATABASE_URL` to a localhost `*_test` database first):

```sh
NODE_ENV=test SESSION_TOKEN_SECRET=local-powerup-lock-fence-test-secret-material \
  REFERRAL_IP_HMAC_ACTIVE_VERSION=1 \
  REFERRAL_IP_HMAC_SECRET_V1=local-referral-test-secret-material \
  node --test --test-concurrency=1 --test-force-exit \
  test/integration/powerup-lock-cost.test.js \
  test/integration/powerup-lock-fence-compat.test.js \
  test/integration/powerup-participant-locks.test.js
```

Run the unchanged cost fixture against the baseline checkout to obtain the
baseline measurements; do not weaken the deliberately failing baseline lock
assertions. Use separate sequential runs so fixture cleanup never races another
suite on the same database.

Frontend has no changes. `flutter analyze` passed; 43 existing tests passed across
activation clarity, error/inventory restoration, team targeting, legacy outcome
compatibility, reflection/blocked combinations and Decoy reveal behavior. Both
iOS and Android share the same unchanged API/Dart flow. Mobile binaries were not
built because no frontend, dependency or build configuration changed.

No production or staging writes/reloads were performed. API shape and gameplay
rules must remain unchanged for old clients; no new flags or migrations.
