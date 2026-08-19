-- Exact consequence commits (Trail Mine, Drill Sergeant, and participant
-- freeze/forfeit boundaries) persist their signed snapshot on recipient work
-- in the same C0 transaction. Nullable keeps every existing row and old binary
-- compatible; ordinary timed/direct work continues to derive from generation
-- capture when this field is absent.
ALTER TABLE "active_race_impact_work"
  ADD COLUMN "captured_delta_steps" INTEGER;
