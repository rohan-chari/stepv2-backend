# Trail Mine placement and accessory preview deployment

Production runtime `92b386e78565e58875996619936e44e4038f5d2e` was deployed on September 10, 2026 with explicit user authorization. Release tag: `deploy/trail-preview-20260910-92b386e`. The isolated release was built directly on the deployed `b8a2969` baseline, preserving the paged mystery-box preview repair and released 500/3000/7500 coin quantities with their existing product and store IDs.

An existing owner-visible Trail Mine effect now includes optional `trailMine.positionSteps`. Other racers and teammates cannot see another player's placed mine. The value comes from existing cached raw effect state during viewer projection, adding no database query. Missing or malformed historical placement metadata leaves the effect visible without a position. Existing trigger, shield, expiry and feed privacy behavior is unchanged.

The new authenticated `GET /shop/items/:itemId/preview` returns a complete server-selected character and compatible preview outfit including the candidate accessory. It prefers an approved active character, then approved default, then an eligible visible fallback mannequin. An unowned fallback does not grant ownership or wardrobe access. Candidate slot replacement and accessory conflicts are resolved server-side. The service uses two to four bounded SELECTs in a read-only transaction and does not change saved outfits, active character, ownership, revisions or coins. Existing authentication capability bookkeeping remains unchanged. Personalized responses use `Cache-Control: private, no-store`.

No migration, dependency, configuration, price or reward-odds change was introduced. Frozen clients ignore the additive mine metadata; clients that never call the preview endpoint retain existing behavior. New clients handle unavailable preview responses safely.

## Verification

The exact release passed all 30 real HTTP/Postgres/Redis integration tests, with zero failures or skips. Coverage includes active/default/unowned fallback rendering, hidden and earned-item eligibility, conflict removal, unchanged stored state, existing wardrobe mutations, multiple and malformed mine placements, owner/rival/team privacy on warm shared snapshots, and triggered or shield-blocked mine disappearance. Tests were written before implementation and failed on the missing endpoint and placement field. The previously reviewed same-scope implementation passed all 3,399 unit tests on the verified local test database; that broad suite was not repeated for the clean release cherry-pick. Architect and implementation reviews approved the change.

Guarded reload preserved exactly two HTTP workers, one resolution worker and one cron worker, with total database pool budget 32. Staging stayed stopped. Environment and the existing modified package lock were backed up and hash-verified unchanged. Health and Redis returned `ok`.

Live authenticated smoke checks at 22:01 UTC returned HTTP 200 for accessory preview with a complete two-accessory context, character listing, race progress, inventory, shop powerups and the guide. iOS billing still returned 500/3000/7500 with unchanged product/store IDs; Android billing remained unavailable. Progress retained `reelPreviewAvailable: true` with 20 probability entries. Decoy remained 150 coins, and the guide retained availability version 2 and 15 explicit empty upgrade-tier rows. Production mines or ownership rows were not created for smoke testing; owner mine lifecycle/privacy is covered by the local integration tests.

Referral catch-up audit, apply and final audit all reported zero missing race activities and review ownership; apply inserted zero rows. This backend record does not assert completion of the separate Apple build upload or App Review workflow.

Evidence: [deployment](artifacts/trail-mine-accessory-preview/deployment.json), [live responses](artifacts/trail-mine-accessory-preview/live-verification.json), [tests](artifacts/trail-mine-accessory-preview/tests.json). Evidence contains aggregate responses and source-log hashes, with authentication, account identifiers, database addresses and machine-specific paths omitted.
