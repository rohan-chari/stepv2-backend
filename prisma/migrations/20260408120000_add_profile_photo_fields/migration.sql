ALTER TABLE "users"
ADD COLUMN "profile_photo_url" TEXT,
ADD COLUMN "profile_photo_key" TEXT,
ADD COLUMN "profile_photo_prompt_dismissed_at" TIMESTAMP(3);
