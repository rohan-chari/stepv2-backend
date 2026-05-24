ALTER TABLE "users" ADD COLUMN "is_review_account" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "users_is_review_account_idx" ON "users" ("is_review_account");
