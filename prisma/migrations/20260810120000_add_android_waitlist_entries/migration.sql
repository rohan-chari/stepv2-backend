-- Marketing site rebuild: Android waitlist email capture (barastep.com).
--
-- A brand-new standalone table. Nothing existing reads or writes it, no FK to
-- users, no column on an existing model is touched — so this is inert for every
-- deployed backend and every app version in the wild, and safe to apply ahead of
-- the code that uses it.
--
-- No user FK is deliberate: a waitlist signup is an anonymous marketing-site
-- visitor who by definition does not have an account yet (they can't — there is
-- no Android build). Nothing to cascade on account deletion.
--
-- The UNIQUE index on "email" is load-bearing, not hygiene: POST
-- /waitlist/android answers 200 on a resubmission rather than erroring, and it
-- does that by catching the P2002 this index raises. The command layer stores
-- the trimmed+lowercased form so the index actually catches case variants.

CREATE TABLE "android_waitlist_entries" (
  "id"         TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "android_waitlist_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "android_waitlist_entries_email_key" ON "android_waitlist_entries"("email");
