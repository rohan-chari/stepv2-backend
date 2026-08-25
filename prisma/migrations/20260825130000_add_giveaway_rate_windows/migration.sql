-- Cross-worker rate limits for the public contest detail and entry endpoints.
-- Only versioned HMAC/digest keys are stored; no raw network address or user ID.
CREATE TABLE "giveaway_rate_windows" (
  "kind" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "window_start" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "giveaway_rate_windows_pkey" PRIMARY KEY ("kind", "key_hash")
);

CREATE INDEX "giveaway_rate_windows_updated_at_idx"
  ON "giveaway_rate_windows"("updated_at");
