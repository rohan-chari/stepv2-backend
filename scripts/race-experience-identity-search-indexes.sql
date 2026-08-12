\set ON_ERROR_STOP on

-- Idempotent, OUT-OF-TRANSACTION companion to
-- 20260811190000_race_identity_and_auto_link. Do not wrap this file in BEGIN:
-- PostgreSQL forbids CREATE INDEX CONCURRENTLY inside a transaction block.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_display_name_search_trgm_idx"
  ON "users" USING GIN (lower("display_name") gin_trgm_ops)
  WHERE "display_name" IS NOT NULL AND "is_review_account" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS "users_discoverable_name_search_trgm_idx"
  ON "users" USING GIN ("discoverable_name_search" gin_trgm_ops)
  WHERE "discoverable_name_search" IS NOT NULL
    AND "name_setup_completed_at" IS NOT NULL
    AND "is_review_account" = false;
