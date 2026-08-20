-- Exact provenance is required before a rejected race use may mint an item
-- back into the account-wide inventory. False is fail-closed for all legacy
-- rows and for mixed-version writers that do not yet know about this column.
ALTER TABLE "race_powerups"
ADD COLUMN "redeemed_from_inventory" BOOLEAN NOT NULL DEFAULT false;
