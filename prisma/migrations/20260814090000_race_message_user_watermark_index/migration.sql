-- The activity-only message contract rebuilds a body-free USER watermark with
-- this exact predicate/order. A partial covering order avoids filtering other
-- kinds/deleted rows and avoids the incremental id tie-break sort. Prisma
-- cannot represent partial/descending indexes; preserve this raw artifact.
CREATE INDEX CONCURRENTLY "race_messages_user_watermark_idx"
  ON "race_messages" (
    "race_id",
    "kind",
    "created_at" DESC,
    "id" DESC
  )
  WHERE "deleted_at" IS NULL;
