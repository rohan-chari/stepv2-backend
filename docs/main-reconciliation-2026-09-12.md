# Main reconciliation — 2026-09-12

Status: source integration verified; production deployment and native app releases remain pending.

## Integrated work

- Frontend: recap branch d0f69e5 and approved immediate challenge Join b32d06f merged as b0d65c7. Runtime merged without conflicts; two documentation conflicts resolved to the later approved implementation record.
- Backend: origin/main f562902 plus notification snapshot repair retirement 9f9cd93. Eight missing documentation commits incorporated (b972558, ad3e0cb, eb52ce5, bfab4fed, cf71cc12, fdd4901, 588aeea, 5a1ac577).
- Frontend validation on combined tree: 261 tests across six affected suites passed; flutter analyze clean. Code reviewer: SHIP, no findings. No native dependency or platform-specific changes. Required manual placement checklist is below.
- Backend retirement: prior tests-first validation of this exact runtime delta passed 70 tests in four database-backed suites against a dedicated local test database; independent reviewer SHIP. Reconciliation adds only historical documentation beyond that tested commit.
- Existing baseline failures remain tracked separately in docs/existing-test-failures-2026-09-11.md (frontend) and the backend recap verification documents. Full suites were not rerun here; this is not an all-green repository claim.

## Production comparison

- Read-only server check: checkout f562902; two HTTP processes plus cron/resolution online; staging stopped. Notification retirement remains pending. No production mutation or deployment was performed.
- Production package-lock.json has pre-existing peer-metadata changes only: no package version, integrity or resolved URL changes in the diff. Preserved; checkout is therefore not byte-for-byte pristine.
- Only pending backend runtime file relative to observed production: src/modules/notifications/jobs/notificationCompletenessReconciler.js. No pending migration, dependency or process configuration change from this reconciliation.
- Backend already has both frontend contracts. Updated Flutter still needs matching iOS/Android release builds and device verification. Last recorded iOS upload/review handoff is 2.3.13(23), with Android artifact 203153; store state was not queried in this audit. Main commits do not automatically update installed binaries.

## Branch accounting

All fetched local/origin branch tips were inventoried: 33 distinct frontend tips and 120 backend tips before creating reconciliation branches. Branches already ancestral to origin/main require no replay. The non-ancestral tips follow; patch-equivalent does not mean identical commit ancestry. No branches were deleted.

| Repository / branch aliases | Original tip | Disposition |
| --- | --- | --- |
| frontend: `2.3.9`, `origin/2.3.9` | `8cb99658` | Historical compact-payload variant: current main retains compact views, target context and conditional streams; obsolete k6 harness is absent. Preserve old release branch. |
| frontend: `feat/simple-event-recap`, `origin/feat/simple-event-recap` | `d0f69e5a` | Integrated; original commit is now an ancestor. |
| frontend: `feature/immediate-challenge-join` | `b32d06f5` | Integrated; original commit is now an ancestor. |
| backend: `archive/pre-event-main-sync-20260910` | `a2f575a7` | Archived pre-integration tree; wardrobe release A replaced by 1ccb009 plus subsequent fixture repairs. Preserve. |
| backend: `archive/pre-integrated-refund-d47b309` | `d47b3099` | All patches already represented on reconciled main; original history preserved. |
| backend: `backup/pre-flatten-20260903` | `68865a07` | Pre-flatten backup with historical experiments and reverts; preserve, do not replay. |
| backend: `codex/capacity-campaign-20260819` | `049500e8` | Superseded by role-aware production pool budgets (26f2458/e877ffd); current ecosystem has a separate resolution role. |
| backend: `event-traffic-source-ablation` | `15b1341e` | Diagnostic rollback for source-loading comparison; exclude from release. |
| backend: `experiment/powerup-command-queue`, `origin/experiment/powerup-command-queue` | `7606ad5c` | Isolated queue prototypes and benchmarks; exclude from release. |
| backend: `feature/event-fingerprint-cache` | `db9cd34d` | Earlier variant superseded by release 393edb4 and subsequent cache fixes. |
| backend: `feature/immediate-challenge-join`, `origin/feature/immediate-challenge-join` | `b9725582` | All patches already represented on reconciled main; original history preserved. |
| backend: `fix/paged-box-preview` | `9b368854` | All patches already represented on reconciled main; original history preserved. |
| backend: `fix/prod-step-incident-20260911`, `origin/fix/prod-step-incident-20260911` | `ad3e0cb3` | All patches already represented on reconciled main; original history preserved. |
| backend: `fix/retire-notification-snapshot-repair-20260912`, `origin/fix/retire-notification-snapshot-repair-20260912` | `9f9cd939` | Integrated; original commit is now an ancestor. |
| backend: `fix/shared-powerup-race-guards`, `origin/fix/shared-powerup-race-guards` | `eb52ce5f` | All patches already represented on reconciled main; original history preserved. |
| backend: `hotfix/dependency-closure-boundary-sql`, `origin/hotfix/dependency-closure-boundary-sql` | `14cef94a` | All patches already represented on reconciled main; original history preserved. |
| backend: `perf/display-refresh-reproduction`, `origin/perf/display-refresh-reproduction` | `3466f771` | Historical reproduction tests; preserve for investigation, not certified against current behavior. |
| backend: `perf/guarded-display-experiment`, `origin/perf/guarded-display-experiment` | `3cb21eaf` | Unreleased guarded-display experiment; preserve, not a release candidate. |
| backend: `perf/prepared-plan-experiment` | `29e3d5b8` | Monitoring documents incorporated; benchmark experiment ef69b723 retained separately. |
| backend: `perf/prepared-read-release`, `origin/perf/prepared-read-release` | `588aeeab` | All patches already represented on reconciled main; original history preserved. |
| backend: `perf/race-display-boundary-20260911` | `a45dc89f` | All patches already represented on reconciled main; original history preserved. |
| backend: `perf/race-resolution-efficiency-20260820` | `2b0fe1e1` | All patches already represented on reconciled main; original history preserved. |
| backend: `perf/scoring-state-lock`, `origin/perf/scoring-state-lock` | `cf71cc12` | All patches already represented on reconciled main; original history preserved. |
| backend: `release/event-end-batch-20260909`, `origin/release/event-end-batch-20260909` | `452c50fd` | All patches already represented on reconciled main; original history preserved. |
| backend: `release/feature-control-cleanup-20260820`, `origin/release/feature-control-cleanup-20260820` | `fa8e8b51` | Superseded by integrated control cleanup c94651c, 94f8273 and 45501de. |
| backend: `release/feature-control-cleanup-phase2-20260820`, `origin/release/feature-control-cleanup-phase2-20260820` | `13c16556` | Superseded by integrated phase 2 c94651c and later permanent cleanup. |
| backend: `release/feature-control-cleanup-phase2-final-20260820`, `origin/release/feature-control-cleanup-phase2-final-20260820` | `f349fb31` | Superseded by integrated phase 2 c94651c and later permanent cleanup. |
| backend: `release/summary-lease-fix`, `origin/release/summary-lease-fix` | `8dbcca0e` | All patches already represented on reconciled main; original history preserved. |
| backend: `release/trail-preview-21`, `origin/release/trail-preview-21` | `430a2896` | All patches already represented on reconciled main; original history preserved. |
| backend: `shop-wardrobe-deployment-evidence`, `origin/shop-wardrobe-deployment-evidence` | `5a1ac577` | All patches already represented on reconciled main; original history preserved. |
| backend: `wip/admin-metrics-reconcile-20260819` | `1fcea300` | WIP preservation snapshot from earlier main reconciliation; retain separately, not a release candidate. |
| backend: `origin/feature/race-preview-and-cleanse-power-outage` | `226fd2cc` | Preview shipped via cbd18d3; the Cleanse exclusion was explicitly reverted by b1270cc. Do not reintroduce it. |
| backend: `origin/perf/prepared-plan-experiment` | `ef69b723` | Monitoring documents incorporated; benchmark experiment ef69b723 retained separately. |

## Preserved unfinished work

- Both primary checkouts contained modified docs/economy.md and untracked research/specification documents. Preserve these outside the release commits; draft files are not approved implementation.
- Two old backend baseline worktrees contain modified integration fixtures. Two scaling worktrees have an experimental resolution concurrency increase from 5 to 20; that capacity experiment is explicitly excluded.
- Any untracked document colliding with a newly integrated tracked document is retained in the named reconciliation stash and private local backup. Do not overwrite the approved tracked document with a stale draft.

## Manual UI placement checklist — pending

Run on both iOS and Android, including a small device and enlarged system text:
1. Races → Public Races → Featured: auto-join settings above cards, cards before tournaments; Join/loading/View share one bottom action area. No duplicate Featured strip on the Races tab.
2. Check daily/weekly cards for upcoming enrollment, unavailable entry and forfeited participation. Status/count/action remain inside the card without overlap.
3. Open the browser from Home Browse/Browse All and the trailing public-race card. Each uses the same Featured layout; Home suggestions stay in place.
4. Cold-open/resume Home with an eligible recap: one centered dialog with title, amount, explanation and reachable Continue.
5. With results, recap and invitations pending, verify separate results → recap → invitation overlays. Recap must not cover race detail or another tab.
6. Settings → View Tutorial (Home/Races/race detail) and fresh-account onboarding demo: no recap over spotlights/coaching; anchors and Home suggestions stay aligned. The public browser is not mirrored by a tutorial beat, so test it directly.

This checklist was produced by the required UI-test-planner review; manual device checks have not been performed in this reconciliation.
