-- Allow NULL on races.max_participants to represent "no participant limit"
-- (unlimited). Additive/backward-compatible: existing rows keep their integer
-- value, the column default of 10 is unchanged, and only the NOT NULL constraint
-- is relaxed. Older app clients always send an integer, so this does not change
-- their behaviour; new clients may send NULL to create an unlimited race.
ALTER TABLE "races" ALTER COLUMN "max_participants" DROP NOT NULL;
