# Redis cache efficiency production deployment

The user explicitly authorized deployment after the six broader failures were confirmed on the original code, accepting those unrelated baseline failures for this release. Deployment completed September10,2026 UTC. No frontend release is required: Flutter product code, API contracts, native configuration and client capabilities are unchanged.

## Artifacts and cutover

- Previous production: `9e99fcbd6799cd944ddbbe7e0f0589c5016a4a38`, tagged `pre/redis-efficiency-20260910`.
- Writer foundation A: `cb790cd8b67ed4fb630c715f2c906191070f40e1`, tagged `deploy/redis-efficiency-A-20260910`.
- Reader/freshness B: `488f8b1480ed33d370fca118eaca36946b17466b`, tagged `deploy/redis-efficiency-B-20260910` and `redis-cache-efficiency-B-20260910`.
- Both revisions deployed through the serialized PM2 guard. A was fully online and every pre-A PID had exited before B began. After B, all A PIDs had exited. A is the compatible rollback target for B.
- Final topology: exactly two HTTP workers, one resolution worker and one cron worker; staging stopped. The guard verified the unchanged32-connection application budget and saved PM2 state after each revision.
- No dependency installation, schema migration, Prisma regeneration, capacity adjustment, new flag or native build/upload was needed. All256 existing migrations were applied, with none missing. Intervening baseline commits contained documentation/evidence only.
- Existing server environment and npm-generated lockfile metadata were backed up privately and verified byte-identical after both cutovers. Powerup copy synchronization changed nothing; the three known Decoy balance snapshot differences were preserved.

## Verification

Public API health returned `status=ok,redis=ok`. Redis reports209715200 bytes maxmemory with allkeys-lru. Real production traffic populated the new list, slot, membership-count, milestone, summary, metadata and invite keys; verification used bounded SCAN and did not create artificial production users, races or step uploads.

The required referral ledger audit/apply/final audit reported zero missing rows and zero mutations. At09:08:19UTC, all1626 resolution queue rows were accounted for (15 queued,1611 succeeded), with zero unfinished post-tasks. These changing queue counts reflect live traffic; no zero-workload or production CPU-saving claim is made.

The69-second log observation contained no P2028/P2002/P2024/53300, deadlock, unhandled rejection, TypeError or ReferenceError matches. It did contain existing receipt-collision warnings, billing reconciliation warnings and scheduled races lacking sufficient participants. The resolution error log already contained1798 receipt-collision mentions before the observation, far beyond what B's roughly one-minute uptime could have generated. The receipt claim/finish code is unchanged between A and B. Final read-only checks found zero unfinished post-tasks and zero nonterminal tasks conflicting with receipts. Independent review found no blocker attributable to B and no reason to roll back for these historical warnings. A proposed claimNext race is an unconfirmed follow-up hypothesis, not a confirmed production diagnosis; no receipt/data repair was performed.

Deployment tags were pushed from the authenticated workstation after the server's Git remote declined a write; application deployment and convergence checks had already succeeded. No duplicate reload was performed for that Git authentication issue.

Evidence: [preflight](evidence/redis-cache-efficiency/deployment/preflight.json), [A verification](evidence/redis-cache-efficiency/deployment/after-A.json), [B verification](evidence/redis-cache-efficiency/deployment/after-B.json), [final check](evidence/redis-cache-efficiency/deployment/postcheck.json), [bounded observation](evidence/redis-cache-efficiency/deployment/observation.json). Local/integration results and measured query tradeoffs remain in [validation](redis-cache-efficiency-validation.md) and [reader evidence](redis-cache-efficiency-reader-evidence.md).
