const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { prisma } = require("../setup");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
function sha(value) { return createHash("sha256").update(value).digest("hex"); }

// This is a read-only test oracle, not a call to the production fact loader.
// Materialized roots are read directly with independent chain checks. Roots
// intentionally left unprepared by scalar reuse are reconstructed independently
// from CURRENT + first retained OLD image after their pinned revision, in ONE SQL
// snapshot. The oracle never materializes roots or affects production telemetry.
async function inspectArtifact(artifact) {
  assert.ok(!Object.hasOwn(artifact.payload, "samples"));
  assert.ok(!Object.hasOwn(artifact.payload, "dailySteps"));
  assert.equal(sha(JSON.stringify(stable(artifact.payload))),artifact.payloadDigest);
  const [owner] = await prisma.$queryRawUnsafe(
    "SELECT id,context,context_digest FROM durable_global_event_capture_requests WHERE work_id=$1", artifact.workId);
  assert.ok(owner);
  assert.equal(sha(JSON.stringify(stable(owner.context))), owner.context_digest);
  assert.equal(artifact.payload.durableCaptureId, owner.id);
  assert.equal(artifact.captureSyncRequestId,owner.context.provenance.captureSyncRequestId);
  assert.equal(artifact.captureCoverageThrough.toISOString(),owner.context.provenance.captureCoverageThrough);
  assert.equal(artifact.sourceScoringInputGeneration.toString(),owner.context.provenance.sourceScoringInputGeneration);
  const captureContext = owner.context.captures.find((capture) => capture.raceId === artifact.raceId);
  assert.ok(captureContext);
  const refs = owner.context.roots.filter((root) => captureContext.userIds.includes(root.userId));
  const roots = await prisma.$queryRawUnsafe(
    "SELECT id,user_id,day::text,revision::text,prepared_at,digest,initial_digest,page_count,row_count FROM durable_capture_fact_roots WHERE id=ANY($1::uuid[])",
    [...new Set(refs.map((root) => root.id))]);
  assert.equal(roots.length, new Set(refs.map((root) => root.id)).size);
  for (const root of roots) {
    const ref = refs.find((value) => value.id === root.id);
    assert.deepEqual([root.user_id, root.day, root.revision], [ref.userId, ref.day, ref.revision]);
  }
  const prepared = roots.filter((root) => root.prepared_at);
  const pages = prepared.length ? await prisma.$queryRawUnsafe(`
    SELECT root_id,page_number,rows,prior_digest,cumulative_digest,row_count,
      digest=encode(sha256(convert_to(rows::text,'UTF8')),'hex') AS valid,
      cumulative_digest=encode(sha256(convert_to(prior_digest||'|'||digest||'|'||page_number::text,'UTF8')),'hex') AS valid_chain
    FROM durable_capture_fact_pages WHERE root_id=ANY($1::uuid[]) ORDER BY root_id,page_number`,
  prepared.map((root) => root.id)) : [];
  for (const root of prepared) {
    assert.equal(root.initial_digest, sha(root.user_id + "|" + root.day + "|" + root.revision));
    const selected = pages.filter((page) => page.root_id === root.id);
    assert.equal(selected.length, root.page_count);
    let prior = root.initial_digest;
    let count = 0;
    for (const page of selected) {
      assert.equal(page.valid, true); assert.equal(page.valid_chain, true);
      assert.equal(page.prior_digest, prior);
      assert.equal(page.row_count, page.rows.length);
      prior = page.cumulative_digest; count += page.rows.length;
    }
    assert.equal(prior, root.digest); assert.equal(count, root.row_count);
  }
  const unprepared = roots.filter((root) => !root.prepared_at);
  if (unprepared.length) {
    const [coverage] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS valid
      FROM durable_capture_fact_roots r LEFT JOIN durable_capture_fact_heads h
        ON h.user_id=r.user_id AND h.day=r.day
      WHERE r.id=ANY($1::uuid[]) AND COALESCE(h.compacted_revision,0)<=r.revision
        AND (h.user_id IS NOT NULL OR r.revision=0)`,unprepared.map((root)=>root.id));
    assert.equal(coverage.valid,unprepared.length,"unprepared accepted roots require retained reconstruction history");
  }
  const reconstructed = unprepared.length ? await prisma.$queryRawUnsafe(`
    WITH wanted AS (SELECT * FROM durable_capture_fact_roots WHERE id=ANY($1::uuid[])),
    changed AS (
      SELECT DISTINCT ON(r.id,j.kind,j.row_id) r.id AS root_id,j.kind,j.row_id,j.before_fact AS fact
      FROM wanted r JOIN durable_capture_fact_journal j
        ON j.user_id=r.user_id AND j.day=r.day AND j.revision>r.revision
      ORDER BY r.id,j.kind,j.row_id,j.revision
    ), current_facts AS (
      SELECT r.id AS root_id,'sample'::text AS kind,s.id::text AS row_id,
        jsonb_build_object('rowId',s.id,'userId',s.user_id,'steps',s.steps,
          'periodStart',to_char(s.period_start,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'periodEnd',to_char(s.period_end,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) AS fact
      FROM wanted r JOIN step_samples s ON s.user_id=r.user_id
      WHERE (r.day=DATE '0001-01-01' AND s.period_end::date-s.period_start::date>=32)
         OR (r.day<>DATE '0001-01-01' AND s.period_end::date-s.period_start::date<32
           AND s.period_start<r.day+INTERVAL '1 day' AND s.period_end>r.day::timestamp)
      UNION ALL
      SELECT r.id,'daily',s.id::text,jsonb_build_object('rowId',s.id,'userId',s.user_id,'steps',s.steps,
        'date',to_char(s.date,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      FROM wanted r JOIN steps s ON s.user_id=r.user_id AND s.date=r.day
    )
    SELECT kind,row_id AS "rowId",fact FROM current_facts c
    WHERE NOT EXISTS (SELECT 1 FROM changed j WHERE j.root_id=c.root_id AND j.kind=c.kind AND j.row_id=c.row_id)
    UNION ALL SELECT kind,row_id AS "rowId",fact FROM changed WHERE fact IS NOT NULL`,
  unprepared.map((root) => root.id)) : [];
  const unique = new Map();
  for (const row of [...pages.flatMap((page) => page.rows), ...reconstructed]) {
    const key = row.kind + ":" + row.rowId;
    if (unique.has(key)) assert.deepEqual(unique.get(key).fact, row.fact, "duplicate day copies must agree");
    unique.set(key, row);
  }
  const payload = captureContext.payload;
  const samples = [], dailySteps = [];
  for (const { kind, fact } of unique.values()) {
    if (!captureContext.userIds.includes(fact.userId)) continue;
    const { rowId: _rowId, ...value } = fact;
    if (kind === "sample" && new Date(fact.periodEnd) > new Date(payload.race.startedAt) &&
        new Date(fact.periodStart) < new Date(payload.cutoffAt)) samples.push(value);
    if (kind === "daily" && new Date(fact.date) >= new Date(captureContext.rangeStart) &&
        new Date(fact.date) <= new Date(captureContext.rangeEnd)) dailySteps.push(value);
  }
  samples.sort((a,b) => a.userId.localeCompare(b.userId) || a.periodStart.localeCompare(b.periodStart));
  dailySteps.sort((a,b) => a.userId.localeCompare(b.userId) || a.date.localeCompare(b.date));
  return { artifact, captureContext, pinnedFacts: { samples, dailySteps, roots }, owner };
}


module.exports = { inspectArtifact };
