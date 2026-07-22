-- Additive only. Old backend binaries continue to understand every prior value.
ALTER TYPE "PowerupType" ADD VALUE IF NOT EXISTS 'quicksand' BEFORE 'mystery_box';
