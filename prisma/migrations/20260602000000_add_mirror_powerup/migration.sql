-- Additive only: add the new MIRROR powerup type to the PowerupType enum.
-- Placed BEFORE 'mystery_box' to match the schema's declared ordering.
-- No existing enum values, columns, endpoints, or response fields are removed
-- or renamed, so old app versions and the current backend remain compatible.
ALTER TYPE "PowerupType" ADD VALUE 'mirror' BEFORE 'mystery_box';
