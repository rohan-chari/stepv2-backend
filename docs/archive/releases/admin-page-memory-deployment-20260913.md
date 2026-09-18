# Per-page admin snapshots production deployment

The user explicitly authorized deployment after the reviewed, tested implementation. Production runtime is `9471f15247b154a3ec654a09c88d02b7f769c625`, tagged `deploy/admin-page-memory-20260913-9471f15`. Rollback tag `pre-admin-page-memory-20260913` points to previous runtime `9f6add46d603952f2dbb880f3c77610c5759f004`.

The guarded reload succeeded with two HTTP workers, one resolution worker and one cron worker; aggregate database pool ceiling remains 32 and staging remains stopped. Dependencies, schema, ecosystem and environment did not change. No migration or dependency installation was necessary. Existing remote environment and package-lock hashes were preserved. Powerup copy already matched; known Decoy configuration drift was reported without changing policy. Referral catch-up audit/apply/audit found and changed zero rows. Public API health and marketing, privacy and support returned HTTP 200.

Authenticated production checks used an existing authorized admin and logged no identities or purchase contents. Every one of the nine page endpoints returned HTTP 200 and retained an identical snapshot timestamp on its immediate warm repeat:

| Page | First completion ms | Warm ms |
|---|---:|---:|
| Overview | 6,119 | 13 |
| Activity | 23,262 | 80 |
| Ads | 1,032 | 24 |
| Retention | 712 | 45 |
| Growth | 534 | 7 |
| Races | 2,030 | 9 |
| Invites | 224 | 8 |
| Onboarding | 4,407 | 15 |
| Shop | 769 | 30 |

First completion includes cold waiting, completion polling where needed, and the immediate warm check. Activity required two pending follow-ups; these are real cold calculations, not a claim of instant first load. All snapshots advertise 900-second freshness. Active-user values and Ads fields were present.

The existing no-view Activity endpoint initially returned its compatible cold 503 at 10 seconds while work continued. A subsequent check returned HTTP 200 in 139 ms with active-user values. This expected cold response is recorded separately from a failed calculation. Purchase history returned five records with username fields. The production smoke evidence retains both the initial response and successful follow-up.

The updated page-qualified frontend is committed as `94ee67b`; carrying TestFlight build 2.3.14 (2) is being prepared after successful backend checks. Existing binaries retain their full response shape and benefit from the streamed DAU correction. No App Review submission, customer release or Play upload is authorized by this verification.

These are individual production smoke measurements, not sustained-load or database-CPU reduction claims. Manual device checks remain pending.
