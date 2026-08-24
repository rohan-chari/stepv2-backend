-- Additive indexes for the transactional Inbox read-all mutation.
-- Existing clients and rows are unchanged; old backend code ignores these.
CREATE INDEX "inbox_alerts_user_id_read_at_expires_at_idx"
  ON "inbox_alerts"("user_id", "read_at", "expires_at");

CREATE INDEX "feedback_threads_user_id_user_read_at_expires_at_idx"
  ON "feedback_threads"("user_id", "user_read_at", "expires_at");
