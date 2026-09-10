# Paged mystery-box preview repair — September 10, 2026

Deployed runtime `28a7e70e5253cd44154d6f641503e74007cbe8cc` to production with the user's explicit deployment authorization. Build 19 requires server preview metadata, but active timezone-backed solo races using `participants-v1` omitted `dropOdds`. This caused the installed app to show generic mystery-box tiles. Production before/after checks confirmed that omission and its repair.

Paged progress now returns the existing additive odds contract using one race-scoped SELECT returning one summary row. PostgreSQL computes ordinal raw-step position across accepted participants, whole-race null fallback, and persisted total-step extrema; existing probability and capability helpers remain authoritative. The query scans/ranks the accepted roster in PostgreSQL without returning or hydrating the roster. Cost increases by one SELECT per eligible paged progress request, zero writes and zero jobs. No cache or migration was added. Actual rolls, prices, and reward probabilities are unchanged.

Full and team progress retain their existing paths. Older clients keep compatible responses; both installed iOS and Android clients benefit without a new binary. The frontend placeholder presentation and deliberately unavailable tutorial previews remain separate frontend work.

Validation:

- New endpoint tests failed on missing paged odds before implementation.
- Exact committed artifact: 19/19 real HTTP/Postgres/Redis tests passed, including all nine catalog tests and ten weekly page-projection tests. Coverage includes warm reads, current/legacy headers, off-page viewers, all-or-nothing raw-step fallback, frozen finishers, tied totals, and viewer-specific Lucky Horseshoe suppression.
- Broader integration run: 31/32 passed. The existing exact-key assertion rejecting `reelPreviewAvailable` reproduced on unchanged production commit `aa14b99`; it was retained.
- Unit suite: 3,391/3,399 passed. All eight failures reproduced on unchanged `aa14b99`; baseline worktree additionally failed two capacity artifact/path checks. No existing assertion was changed.
- Independent code reviewer: SHIP, no blockers. Game analyst: expected reward and currency delta zero. Existing exact-step/exact-join-time ordering ambiguity in the actual roll remains; this repair does not change roll ordering.
- No Dart/native files changed; Flutter analysis/builds and manual UI placement checks are not part of this backend-only repair.

Deployment used the guarded PM2 reload. Exactly two HTTP workers, one resolution worker, and one cron worker are online; staging remains stopped. Final pool budget is 32. Environment and the pre-existing modified package lock were hash-verified unchanged and backed up on the host. No migration or configuration change; applied migration checks showed none missing or unfinished. Health and Redis report healthy. Referral catch-up audit returned zero missing race activities and review ownership; no apply needed.

Live authenticated reads after reload returned HTTP 200 with `reelPreviewAvailable: true` and 20 probability entries for both paged and compact progress, on first and repeat reads. Before deployment, paged progress returned no preview while compact already returned a valid preview. Verification logs contain only aggregate results, not authentication tokens or account identifiers.

Test counts: [evidence](artifacts/paged-box-preview/tests.json). Release tag: `deploy/paged-box-preview-20260910-28a7e70`. Reopen the race screen to fetch fresh progress in the existing installed app.
