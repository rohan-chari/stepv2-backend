ALTER TABLE "giveaway_contests"
  ADD COLUMN "eligibility_mode" TEXT NOT NULL DEFAULT 'US_18',
  ALTER COLUMN "minimum_age" DROP NOT NULL,
  ALTER COLUMN "minimum_age" DROP DEFAULT,
  ALTER COLUMN "eligible_countries" DROP NOT NULL,
  ALTER COLUMN "eligible_countries" DROP DEFAULT,
  ALTER COLUMN "eligible_regions" DROP NOT NULL;

ALTER TABLE "giveaway_entrants"
  ALTER COLUMN "country" DROP NOT NULL,
  ALTER COLUMN "region" DROP NOT NULL,
  ALTER COLUMN "age_confirmed_at" DROP NOT NULL,
  ALTER COLUMN "residency_confirmed_at" DROP NOT NULL;
