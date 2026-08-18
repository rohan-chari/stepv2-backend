# Capacity phase metrics v1 measurement contract

`capacityPhaseMetricsV1Enabled` is default-off and changes no HTTP contract.
It emits sampled aggregate telemetry only; identifiers, tokens, request bodies,
raw step samples, message bodies, and source values are forbidden.

## Query capture and claimable paired runs

Prisma query events must be enabled **before the Node process loads `src/db.js`**:

```text
PRISMA_QUERY_EVENTS_ENABLED=true
```

Every `capacity_phase_metrics_v1` record publishes:

- `queryCaptureAvailable`
- `queryCaptureSetting` (`PRISMA_QUERY_EVENTS_ENABLED=true` when available,
  otherwise `PRISMA_QUERY_EVENTS_ENABLED!=true`)
- `measurementGateEligible`

When capture is unavailable, `measurementGateEligible` is false and both
`queryCount` and `phaseQueryCount` are omitted. Zero must never be inferred from
a missing field. A benchmark cohort containing an unavailable record fails the
measurement gate.

Baseline and candidate processes in a paired run must use the identical query
capture setting. The setting and availability fields must be retained in all
three structured summaries/raw streams. A pair with a missing, false, or
different availability/setting value is non-claimable and must not be used to
approve Milestone 5.1.

Phase query counts use phase-local async attribution. Concurrent fan-out must
use separate phase-local contexts or one enclosing phase so one query is never
credited to multiple overlapping phases.

## Run correlation and server evidence

Claimable harness requests may send both headers:

```text
X-Capacity-Run-Id: pool3-baseline-r2
X-Capacity-Repeat: 2
```

Run IDs must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}` and repeat must be `1`,
`2`, or `3`. Invalid values are ignored. Valid values appear only as
`dimensions.runId` and `dimensions.repeat` in capacity telemetry; they never
change a request, response, status, cache key, database row, or application
behavior.

Export structured capacity log records as newline-delimited JSON, then extract
the server-derived evidence for one repeat:

```sh
node scripts/extract-capacity-telemetry-evidence.js \
  --run-id pool3-baseline-r2 --repeat 2 < capacity-metrics.ndjson
```

The production console transport writes each capacity record as exactly one
pre-serialized JSON object line (with `message` and `event` at the top level),
so PM2 output needs no prefix stripping or Node-inspect conversion before this
command. Injected test loggers retain the `(message, fields)` callback contract.

The output is embedded under `telemetry` in the harness-owned
`capacity-telemetry-evidence-v1` file:

```json
{
  "schema": "capacity-telemetry-server-evidence-v1",
  "runId": "pool3-baseline-r2",
  "repeat": "2",
  "event": "capacity_phase_metrics_v1",
  "sampleCount": 42,
  "queryCaptureAvailable": true,
  "measurementGateEligible": true,
  "queryCaptureSetting": "PRISMA_QUERY_EVENTS_ENABLED=true",
  "surfaces": ["message_access", "progress_projection_hydration"]
}
```

Extraction fails for an empty cohort, unavailable query capture, an ineligible
measurement gate, or any query-capture setting other than the enabled setting.
The harness aggregator must also require the outer run ID and booleans to equal
this nested server evidence and require `sampleCount > 0`.
