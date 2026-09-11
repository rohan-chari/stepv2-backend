# Mixed scheduler/recovery test disposition

Baseline: `9b08e5f9b50250cae431177e67e73e24dd6b2b34`. Exact original files are
preserved under `retired-event-recap-tests/mixed-originals/`. These two suites
remain active; neither was wholly retired or skipped.

## global-event-end-burst.test.js

Preserved: both 10/40-user bounded cohorts; queue generation/write limits;
concurrent schedulers and HTTP sync; transactional rollback and retry;
failure isolation after the original time budget; multi-page/timezone bounds;
actual historical 2× race scoring for frozen and current clients. Existing
numeric scoring assertions remain unchanged.

Intentionally replaced: old summary enqueue/tick/phase assertions now prove
that ending an event creates no recap or capture work. The mixed
expired/incompatible/zero/existing-result case now proves the corresponding
expired/unknown-stamp/zero-race candidates stay uncalculated and an already
saved recap remains unchanged. The old work receipt check now exercises the
stateless terminal compatibility response.

## global-event-indexed-recovery.test.js

Preserved: notification revision/receipt identity, digest collision handling,
terminal receipts, bounded bootstrap cursors and rollback, notification
publication, nonblocking independent signals, parent deletion lock safety,
orphan high-water/cursor progress, and indexed empty selection amid 20,000
future candidates (original buffer threshold retained).

Intentionally replaced: old V2 summary repair becomes a no-storage stateless
HTTP compatibility check; old once-only V1 recovery becomes HTTP recap
finalization twice with an immutable first result. Bootstrap signals now
publish eight real notifications. Repeated summary hints become 300 revisions
of one entitlement, proving one latest notification plus another ready event.
Impact attribution completion becomes a membership edit that creates no recap
work; membership/account-deletion lock coverage remains. Orphan/index fixture
kinds use retained entitlement recovery rather than retired summary recovery.

Fixture-only metadata for retired attribution fields is removed. Manually
start-processed fixtures explicitly carry the new count/revision stamp where
the case requires eligibility. Historical source copies make every intentional
behavior replacement auditable; these are not mechanical claim-of-parity edits.

## Verification

Both active suites together: **26 passed, 0 failed, 0 skipped**, against a
dedicated local `steps-tracker-recap-root_test` database after migration A and
cutover. Log: local `/tmp/simple-recap-root-mixed-tests-final.log`.
No production database was used. Post-final-drop verification is a separate gate.

Post-final-drop on PostgreSQL 18.4: 25 passed; one protected assertion expects
SQLSTATE `23503` but receives `23001` from the retained RESTRICT foreign key.
The exact unchanged baseline test reproduces this on PostgreSQL 18.4, as does
the replacement before final drop. PostgreSQL 16.14 returns the expected code.
The assertion is preserved, not broadened or skipped. Logs:
`/tmp/simple-recap-root-mixed-tests-post-b.log` and
`/tmp/simple-recap-baseline-pg18-fk.log`. This is an explicit baseline
version-portability failure, not a claimed fully green post-drop mixed suite.
