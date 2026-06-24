-- Shareable race links: opaque per-race token backing https://<host>/r/<token>.
-- Nullable (minted lazily on first share) + unique (token -> at most one race).
-- Additive/backward-compatible: existing rows are NULL; NULLs do not collide in
-- a Postgres UNIQUE index, so adding the constraint never fails on prod data.

-- AlterTable
ALTER TABLE "races" ADD COLUMN "share_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "races_share_token_key" ON "races"("share_token");
