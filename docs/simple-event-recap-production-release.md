# Simple recap production release — 2026-09-11

Status: replacement backend deployed successfully. First verified internal and
public health: **2026-09-11 10:55:18 UTC**.

Runtime release: `8afd680f308abecd4be53d7e5e89a40d3fee0542`.
Release B follow-up is owned by the backend maintainer and must not run before
**2026-09-18 10:55:18 UTC**, with fresh user authorization and backup/restore
checks. It has not been executed or automatically scheduled.

## Scope and recovery

Backend replacement only. Preserve two HTTP workers, one resolution companion,
one cron companion, and the 32-connection aggregate pool budget. Staging stays
stopped. No app upload, capacity change, seed, or final physical retirement.
The old recap binary is **not** a valid rollback after cutover. Recovery must
use the replacement source artifact; restoring production data requires fresh
approval. Release B requires fresh approval and a backup, at least seven days
after successful replacement deployment, not merely the SQL marker.

## Preflight

- Production and remote main: `9b08e5f9b50250cae431177e67e73e24dd6b2b34`.
- Exactly one pending migration: `20260911120000_simple_event_recap_expand`.
- No unfinished migrations. Historical checksum difference for
  `20260405000000_remove_switcheroo_powerup` matches original source commit
  `d12aa89dabf746d66b04461e5ac3e84cad3ccdf5`; later source edit already existed
  on the deployed baseline. Migration history is left untouched.
- Saved-summary snapshot: 6,344 rows; detached capture owners: zero;
  largest retained owner: 140 score points (local rehearsal covered 1,000).
- Only existing production processes were online; staging stopped.
- Existing modified production package-lock is preserved, not replaced.
  SHA-256: `b84adca720b235c1b7e07f54f36df369a47e53ce28ecbcaf1b80eb659d4f60ac`.
- No dependency changes; package script cleanup does not require reinstalling
  dependencies. Regenerate the Prisma client for the additive schema.

## Load evidence

Managed-database metrics at 10:48:33 UTC, during backup transfer: CPU non-idle
44.84% (user 27.26%, system 13.55%, idle 55.16%). This is a single operational
snapshot, not a controlled before/after result or proof of sustained savings.
Controlled synthetic replay evidence remains in the verification report.

## Backup receipt

Private server-side backup directory: `/root/backups/simple-recap-20260911T104131Z`.
Custom-format dump: `step-tracker-prod-20260911T104131Z.dump`, 997,409,042 bytes,
183 table-data entries. SHA-256:
`019081b9eaa3528548ca098fda4214450cbc93685fc5a78a13ae4d803f185e44`.
Local and remote checksums match; local production dump removed immediately
after verification. Existing environment, modified package-lock and ecosystem
configuration are preserved privately in the same server-side directory.

## Deployment results

- Deployment operator independently reviewed: SHIP. Full units 3,376/3,376;
  operator/topology 40/40; real local PostgreSQL identity test 1/1.
- Reviewed main fast-forwarded; Prisma client regenerated. Environment and
  pre-existing modified package-lock hashes are unchanged.
- Compatible replacement source archive retained beside the backup:
  `replacement-8afd680.tar.gz`, SHA-256
  `fd4c23efaf3645b68ba45a4f14ddae3571977c6b5228ead94f223fbece3eceff`.
- Locked stop-all operator completed at 10:54:42.808 UTC with exit zero.
  All old process identities exited; cutover and read-only SQL verifier passed.
- All 6,344 legacy saved recaps copied; eight old triggers removed; zero
  retired recovery candidates. Cutover marker present; final-drop marker absent.
- Replacement processes: resolution PID 1610458, cron PID 1610477,
  HTTP PIDs 1610495 and 1610502. All online, zero restarts, original budget 32;
  topology saved. Staging remains stopped.
- Local and public health both HTTP 200, `ok`. New recap route correctly
  rejects an unauthenticated request with HTTP 401.
- Bounded access-log observation after first verified health through 10:58 UTC:
  successful Home, step and race requests; no HTTP 5xx. Four 502 responses at
  10:54:43–44 occurred during startup before readiness, in addition to the
  intentional stopped-writer maintenance window.
- Sampled application logs contain no new Prisma timeout/missing-column,
  connection-refused, missing-module or old summary/capture-worker messages.
- Required powerup-copy sync found no changes; referral audit/apply/audit
  converged at zero missing race activities and review ownership throughout.
  Balance report shows three existing DECOY policy differences between the
  live v5 config and committed v4 snapshot; live policy was not overwritten.
- No production test fixtures or fabricated step/recap writes were made. No
  configured authenticated smoke credential was available. Real production
  request success and prior local HTTP/scoring/compatibility integration tests
  provide evidence, but do not replace an on-device recap check.

CPU snapshots after startup: 34.03% non-idle at 10:55:57 UTC and 38.84% at
10:58:42 UTC, versus 41.00% immediately before cutover at 10:52:36 UTC.
These uncontrolled samples do not establish a sustained CPU reduction.

Previously reproduced unrelated test failures are tracked separately in the
test-disposition documents, as explicitly accepted by the user. No protected
assertions were weakened to deploy this change.
