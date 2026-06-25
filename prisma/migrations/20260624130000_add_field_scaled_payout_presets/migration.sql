-- Field-scaled payout presets: pay the top half of the field, or everyone but
-- last. Additive enum values; existing races keep their current preset.
ALTER TYPE "RacePayoutPreset" ADD VALUE 'top_half';
ALTER TYPE "RacePayoutPreset" ADD VALUE 'all_but_last';
