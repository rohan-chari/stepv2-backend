async function writeCapacityOperatorMarker(client, { runId, markerHash } = {}) {
  if (!runId || !markerHash) throw new Error("capacity operator marker requires run identity");
  await client.query(`
    CREATE TABLE IF NOT EXISTS capacity_operator_runs (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton = true),
      run_id text NOT NULL,
      marker_hash text NOT NULL,
      sanitized_at timestamptz NOT NULL
    )
  `);
  await client.query(`
    INSERT INTO capacity_operator_runs (singleton, run_id, marker_hash, sanitized_at)
    VALUES (true, $1, $2, NOW())
    ON CONFLICT (singleton) DO UPDATE SET
      run_id = EXCLUDED.run_id,
      marker_hash = EXCLUDED.marker_hash,
      sanitized_at = EXCLUDED.sanitized_at
  `, [runId, markerHash]);
}

module.exports = { writeCapacityOperatorMarker };
