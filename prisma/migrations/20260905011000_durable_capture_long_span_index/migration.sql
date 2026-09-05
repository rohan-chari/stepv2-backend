CREATE INDEX CONCURRENTLY IF NOT EXISTS step_samples_durable_long_spans
  ON step_samples(user_id,period_start,period_end)
  WHERE period_end::date - period_start::date >= 32;
