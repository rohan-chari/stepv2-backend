ALTER TABLE "step_samples"
ADD COLUMN "source_name" TEXT,
ADD COLUMN "source_id" TEXT,
ADD COLUMN "source_device_id" TEXT,
ADD COLUMN "device_model" TEXT,
ADD COLUMN "recording_method" TEXT,
ADD COLUMN "metadata" JSONB;
