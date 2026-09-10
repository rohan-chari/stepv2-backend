# Decoy shop restoration and cooldown

Implementation: restore Decoy at150 base coins (128 with existing membership discount) and enforce one hour after an attack consumes it. Existing endpoint/error envelope and old-client gates remain compatible. Natural expiry does not trigger cooldown. Held items are retained and redeemed inventory is refunded on rejection.

The nullable effect timestamp and composite lookup index keep cooldown enforcement bounded and preserve bulk Power Outage writes. Migrations20260910120000_restore_decoy_shop_cooldown and20260910120100_decoy_cooldown_index narrowly update Decoy catalog/copy and add storage; the latter creates its index concurrently. No other live balance settings or box odds change.

Validation on dedicated localhost steps-tracker-integration_test:
-13 new public HTTP tests and9 existing Decoy tests pass.
- Actual migration-file isolation test passes:75/inactive to150/active, eligibility and unrelated rows preserved, historical timestamps null, exact index present.
- Sept6 and participant-lock/C0/shared-race regression tests pass.
-3397 unit tests pass,0 failures/skips.
- Expanded wave5 integration tests have one unrelated Drill Sergeant failure (expected−1500, observed0), reproduced on unchanged baseline45e622d; assertion retained. The full backend integration suite is not claimed green.
- Independent read-only implementation review: no required fixes. Both repositories pass git diff --check.

Local evidence logs: /tmp/decoy-tests-before.log, /tmp/decoy-tests-after.log, /tmp/decoy-related-tests.log, /tmp/decoy-migration-tests.log, /tmp/decoy-baseline-wave5.log, /tmp/decoy-unit-tests.log. Test logs are local evidence, not production data.

Deployment status: pending. Deploy backend before TestFlight build18; preserve exactly two HTTP workers and stopped staging. Verify both migration checksums/index validity, live base price150, legacy/current GET catalog behavior, refreshed description (existing60s cache), health and worker topology.
