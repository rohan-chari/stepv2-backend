# Effect fingerprint reuse

## Summary and approved scope
Reduce redundant effect history reads in step-driven race resolution without changing scores. User authorized removing the duplicate read, adding the database counter, integration tests, and measured comparison. Production deployment requires separate authorization.

## Current path
`raceResolutionQueueV2.js` captures a planning fingerprint in the closure planner. FULL team fallback discards its digest and captures again. `raceResolutionInputFingerprint.js` loads all scoring effects at planning and final validation, including conditional Leech checkpoint JSON. Normal path has two full effect reads; team FULL has three. Scoring already reuses the planning effects.

## Implementation
1. Write failing real HTTP sync / real worker / local PostgreSQL integration cases for normal and team paths, unchanged scores, mutation before final fence, missing proof, time boundaries, and checkpoint invalidation. Observe real SQL passively.
2. Add additive database-maintained per-race effect proof (incarnation UUID and bigint revision). Atomic installation locks source tables before initialization; old writers are covered by triggers. Track effect insert/update/delete, race reassignment, plus truncate. Do not add checkpoint triggers or counter writes to step intake. Prefer bounded set-based statement triggers, skip no-op updates, deterministic lock order. Account for cascade deletion and existing checkpoint trigger lock ordering. Avoid per-effect proof writes in bulk statements where possible.
3. Capture effect rows and their proof in ONE SQL/MVCC snapshot, including an empty-effects sentinel. Private WeakMap provenance stores a defensive copy with finite row/byte/age bounds. Never trust public mutable fingerprint rows as proof. No Redis entry needed.
4. Join current effect revision into the already-required final roster read. Reuse attempt-local effects only for matching race/incarnation/revision, unchanged race time context and admissible monotonic clock before expiry/start boundaries. Refresh conditional checkpoint JSON in that SAME final roster/proof SQL, using only bounded eligible IDs/metadata/expiry from the private effect snapshot and the current race end. Join checkpoints by effect_id (never trust checkpoint.race_id). Only attach fresh checkpoint JSON after effect proof matches; mismatch loads canonical. This preserves checkpoint visibility and every checkpoint mutation without any extra checkpoint write contention. Preserve full fallback for missing/invalid/mismatched proof. Final digest, generation and all other transaction fences remain. No reuse beyond one attempt or forced retry.
5. Reuse the original complete planning fingerprint for FULL source-input fallback only with matching balance version, valid deadline and same attempt. Force-full/retries reload. Preserve terminal handling and all final fences.
6. Run targeted integration regressions and collect actual full history read counts/rows and additional proof write overhead. Report CPU savings as unmeasured until deployed.

## API / frontend / compatibility
No endpoint, request, response or scoring rule changes. Existing iOS and Android clients retain their contracts. Prove old headers through HTTP integration. No frontend code or build required; run flutter analyze. No release flags. Additive migration supports currently deployed writers; deploy backend only after fresh authorization.

## Acceptance
Normal unchanged path one full effect read instead of two; team fallback one instead of three when safely admitted. Concurrent effects invalidate reuse; fresh checkpoint projection changes the final digest when visible checkpoint inputs change, rejecting stale calculations. Empty effects and absent proof are safe. Existing assertions remain intact. Architect review before implementation, code review afterward.

## Revision log
Gap pass 1: added checkpoint writes, time-only checkpoint visibility and same-statement capture to prevent false proof admission.
Gap pass 2: added empty sentinel, defensive private provenance, bounded memory, bulk trigger write amplification, cascade lock ordering, force-full and balance-version guards. No open product questions; architect to resolve implementation details before coding.
Architect revision: avoid a shared race counter on high-frequency checkpoint writes. Version effect rows only; refresh the conditional checkpoint subset in the existing final roster query. This retains necessary checkpoint reads, avoids all new step-intake writes, and preserves the target full-effect read reduction. User-approved objective and behavior unchanged.

Architect review: APPROVE, no required changes after amendment. FULL fallback deadline uses original capture time and config version; no extension. Tests explicitly cover mismatched checkpoint ownership and report retained checkpoint reads separately.
