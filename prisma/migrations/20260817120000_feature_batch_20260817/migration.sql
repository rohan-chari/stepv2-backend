-- Feature batch 2026-08-17. Every object is additive so the currently running
-- binary and frozen clients continue to operate during a rolling deployment.

CREATE TABLE "race_effect_impacts" (
  "id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "effect_id" TEXT NOT NULL,
  "powerup_type" TEXT NOT NULL,
  "delta_steps" INTEGER NOT NULL,
  "attribution_version" INTEGER NOT NULL DEFAULT 1,
  "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMP(3),
  CONSTRAINT "race_effect_impacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "race_effect_impacts_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "race_effect_impacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "race_effect_impacts_race_id_user_id_effect_id_key" ON "race_effect_impacts"("race_id", "user_id", "effect_id");
CREATE INDEX "race_effect_impacts_race_user_ack_settled_idx" ON "race_effect_impacts"("race_id", "user_id", "acknowledged_at", "settled_at" DESC);
CREATE INDEX "race_effect_impacts_user_settled_idx" ON "race_effect_impacts"("user_id", "settled_at" DESC);

CREATE TABLE "global_event_race_impacts" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "delta_steps" INTEGER,
  "attribution_version" INTEGER NOT NULL DEFAULT 1,
  "settled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "global_event_race_impacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_event_race_impacts_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "global_step_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_race_impacts_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_race_impacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "global_event_race_impacts_event_race_user_key" ON "global_event_race_impacts"("event_id", "race_id", "user_id");
CREATE INDEX "global_event_race_impacts_event_user_settled_idx" ON "global_event_race_impacts"("event_id", "user_id", "settled_at");
CREATE INDEX "global_event_race_impacts_user_event_idx" ON "global_event_race_impacts"("user_id", "event_id");

CREATE TABLE "global_event_user_summaries" (
  "id" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "extra_race_steps" INTEGER NOT NULL,
  "race_count" INTEGER NOT NULL,
  "attribution_version" INTEGER NOT NULL DEFAULT 1,
  "settled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledged_at" TIMESTAMP(3),
  CONSTRAINT "global_event_user_summaries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "global_event_user_summaries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "global_step_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "global_event_user_summaries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "global_event_user_summaries_event_user_key" ON "global_event_user_summaries"("event_id", "user_id");
CREATE INDEX "global_event_user_summaries_user_ack_settled_idx" ON "global_event_user_summaries"("user_id", "acknowledged_at", "settled_at" DESC);

CREATE TABLE "app_review_prompt_attempts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "race_id" TEXT NOT NULL,
  "opportunity_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "claimed_at" TIMESTAMP(3),
  "attempted_at" TIMESTAMP(3),
  "policy_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "app_review_prompt_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "app_review_prompt_attempts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "app_review_prompt_attempts_race_id_fkey" FOREIGN KEY ("race_id") REFERENCES "races"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "app_review_prompt_attempts_user_race_key" ON "app_review_prompt_attempts"("user_id", "race_id");
CREATE UNIQUE INDEX "app_review_prompt_attempts_opportunity_key" ON "app_review_prompt_attempts"("opportunity_id");
CREATE INDEX "app_review_prompt_attempts_user_exp_claim_idx" ON "app_review_prompt_attempts"("user_id", "expires_at", "claimed_at");

CREATE TABLE "inbox_alerts" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "destination" JSONB NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "inbox_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "inbox_alerts_user_source_key_key" ON "inbox_alerts"("user_id", "source_key");
CREATE INDEX "inbox_alerts_user_read_created_idx" ON "inbox_alerts"("user_id", "read_at", "created_at" DESC, "id" DESC);
CREATE INDEX "inbox_alerts_expires_at_idx" ON "inbox_alerts"("expires_at");

CREATE TABLE "inbox_delivery_outbox" (
  "id" TEXT NOT NULL,
  "alert_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'PUSH',
  "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_until" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_delivery_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "inbox_delivery_outbox_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "inbox_alerts"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "inbox_delivery_outbox_alert_kind_key" ON "inbox_delivery_outbox"("alert_id", "kind");
CREATE INDEX "inbox_delivery_outbox_claim_idx" ON "inbox_delivery_outbox"("status", "available_at", "lease_until");

CREATE TABLE "feedback_threads" (
  "id" TEXT NOT NULL,
  "suggestion_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "user_read_at" TIMESTAMP(3),
  "staff_read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_threads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_threads_suggestion_id_fkey" FOREIGN KEY ("suggestion_id") REFERENCES "suggestions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "feedback_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "feedback_threads_suggestion_id_key" ON "feedback_threads"("suggestion_id");
CREATE INDEX "feedback_threads_user_exp_last_idx" ON "feedback_threads"("user_id", "expires_at", "last_message_at" DESC, "id" DESC);
CREATE INDEX "feedback_threads_expires_at_idx" ON "feedback_threads"("expires_at");

CREATE TABLE "feedback_messages" (
  "id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "sender_kind" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "feedback_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "feedback_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "feedback_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "feedback_messages_thread_id_idempotency_key_key" ON "feedback_messages"("thread_id", "idempotency_key");
CREATE INDEX "feedback_messages_thread_created_idx" ON "feedback_messages"("thread_id", "created_at", "id");
