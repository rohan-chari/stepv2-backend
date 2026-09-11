# Simple recap production release — 2026-09-11

Status: deployment authorized; backup verified and additive migration A applied.
Old runtime remains online pending stopped-writer cutover. This is not yet a
successful deployment record.

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

## Remaining deployment gates

Verified private remote backup and local-copy removal; independent review of
the locked stopped-writer operator; reviewed source promotion; additive
migration; all-writer termination; identity-bound idle pool session cleanup;
cutover and read-only verifier; guarded replacement startup; health, topology,
configuration preservation, catalog and runtime observation; deployment time
and Release B follow-up date.

Previously reproduced unrelated test failures are tracked separately in the
test-disposition documents, as explicitly accepted by the user. No protected
assertions were weakened to deploy this change.
