# Backend catalog authority deployment

Production runs `aa14b99`, deployed September 10, 2026. The release filters outgoing retired inventory consistently after cache reads, while preserving canonical ownership and capacity. It adds optional viewer-specific `dropOdds.reelPreviewAvailable` metadata using already loaded state; actual rolls and existing probabilities remain unchanged.

No migration, configuration change or additional database query was introduced. Environment and the existing modified package lock were preserved. Production has two HTTP workers, one resolution worker and one cron worker; staging remains stopped. Health and Redis are healthy.

Live authenticated read checks returned HTTP 200 for progress, race inventory, Shop powerups and the guide. Progress returned the new preview boolean with a complete 20-type probability map. Decoy remains 150 coins; the guide returned availability version 2 and 15 explicit empty upgrade-tier rows.

Validation: five new real HTTP/Postgres/Redis tests plus two malformed-state tests passed; 3,399 unit tests passed. Expanded integration run passed 58/63. Its five C3 failures reproduced identically on unchanged baseline `29e86f6`; assertions were retained. Independent review found no required changes. The app must be updated to remove its previously compiled filters; old clients keep compatible API responses.

Evidence: [deployment](artifacts/backend-catalog-authority/deployment.json), [live responses](artifacts/backend-catalog-authority/public-response-verification.json). Tag: `deploy/backend-catalog-authority-20260910-aa14b99`. Previous runtime: `6a0f6c3`. No App Review or Play release is part of this deployment.
