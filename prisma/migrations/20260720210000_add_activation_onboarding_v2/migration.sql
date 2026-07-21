-- Additive-only activation telemetry. Existing tables and API contracts are
-- unchanged; deleting a user cascades only that user's raw activation events.
CREATE TABLE "activation_events" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "onboarding_session_id" TEXT,
    "name" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "app_version" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activation_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activation_events_user_id_idx" ON "activation_events"("user_id");
CREATE INDEX "activation_events_created_at_idx" ON "activation_events"("created_at");
CREATE INDEX "activation_events_name_created_at_idx" ON "activation_events"("name", "created_at");
CREATE INDEX "activation_events_app_version_platform_created_at_idx" ON "activation_events"("app_version", "platform", "created_at");

ALTER TABLE "activation_events"
ADD CONSTRAINT "activation_events_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
