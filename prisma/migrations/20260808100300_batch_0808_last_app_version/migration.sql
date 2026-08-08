-- Batch 2026-08-08 item 9: admin visibility into app-version spread.
--
-- Additive + NULLABLE with NO backfill. Every existing row starts NULL and
-- populates on that user's next authenticated request (old clients already
-- send X-App-Version, so the data lands immediately without an app release).
-- Until then a NULL row is reported to admins in an explicit "unknown" bucket
-- alongside a `since` date, so the section can never be misread as "everyone
-- is on no version".
--
-- Neither column is added to the /auth/me payload, and the sticky write goes
-- through a dedicated model method that deliberately does NOT invalidate the
-- /auth/me cache — a per-user daily write through the User.update chokepoint
-- would gut the hit rate of the #2 endpoint's cache (spec item 9, architect).
--
-- Old deployed backend code never selects either column.

ALTER TABLE "users"
  ADD COLUMN "last_app_version" TEXT,
  ADD COLUMN "last_seen_at" TIMESTAMP(3);

-- Backs the admin version-spread query, which groups by last_app_version over
-- users seen in the last 30 days. Without it that report is a full table scan.
CREATE INDEX "users_last_seen_at_idx" ON "users"("last_seen_at");
