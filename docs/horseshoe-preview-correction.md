# Lucky Horseshoe preview correction — September 12, 2026

Status: implemented and reviewed; production deployment awaits explicit approval.

An active Lucky Horseshoe previously caused `reelPreviewAvailable` to be false,
replacing all decorative reel items with neutral mystery-box placeholders. The
user reproduced this and explicitly requested that Horseshoe never disable the
preview. The helper now authorizes the existing ordinary-pool decoration with
an active Horseshoe, subject to the existing valid-data checks.

`byType`, rarity disclosure, award selection, minimum-rarity guarantee,
self-exclusion and guarantee consumption retain their existing behavior. The
reel's stopping tile uses the actual server award; decorative tiles are not
conditional next-box odds. The game analyst found zero change in award EV and
no new exploit. No queries, writes, jobs, schema changes, config changes or
release controls are added. Older iOS and Android clients consume the same
boolean contract and benefit on their next progress fetch after deployment.

The five existing suppression assertions (four HTTP, one pure helper) were
explicitly identified to the user and updated to the requested behavior. No
other assertions were removed or weakened.

## Validation

- Tests first: five HTTP cases failed specifically on false versus expected
  true before the production-code change, including the two new current/legacy
  guaranteed-open cases.
- Real HTTP/Postgres/Redis: 11/11 passed, including full/paged projections,
  cold/warm reads, another viewer, expired Horseshoe, unchanged ordinary odds,
  successful RARE non-Horseshoe award, and consumption only on opening.
- Integration target: dedicated loopback `horseshoe_preview_20260912_test`.
  The default local integration database had a pre-existing failed migration;
  it was left untouched after the runner rejected it. The fresh database
  applied the existing migrations successfully. No production tests ran.
- Backend unit suite: 3,380 passed, 10 failed. All 10 failures reproduced on
  unchanged baseline `8a03ee6` in the five failing suites (33 passed, 10 failed):
  `newPowerups`, `redeemPowerupToRace`, `raceDetailStepSyncNudge`,
  `hitchhikeScoring`, and `raceStepUndercount.bug1`.
- Frontend: 27/27 real-widget tests passed across `case_opening_reel`,
  `backend_catalog_authority`, and `case_reveal_sync`; Flutter analysis clean.
  No native build is needed for this backend correction.
- Independent code reviewer: SHIP, no blockers/issues/nits.

## Manual UI-placement test plan

Run these real-race checks on iOS and Android after deployment:

1. Races → active race with Lucky Horseshoe active and an unopened box → tap
   box. Powerup previews appear inside the reel before and during opening;
   surrounding tiles are no longer all mystery-box placeholders. No duplicate
   reel appears outside the modal.
2. Active race with Lucky Horseshoe active and at least two unopened boxes →
   Open All. Each displayed reel contains powerup previews in its existing
   tile positions, without an additional placeholder-only reel.
3. Race without Lucky Horseshoe active → open a box. Preview tiles still
   occupy the same reel; nothing overlaps the title or controls.

No layout moves. The demo race tutorial and tab tutorial independently disable
their fake preview data and are unaffected by this backend correction. Open All
is hidden in demo mode. The daily reward accessory reel uses a separate path.
Manual device checks have not been executed as part of this local change.
