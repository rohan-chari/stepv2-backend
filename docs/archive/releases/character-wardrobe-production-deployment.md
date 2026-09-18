# Character wardrobe production deployment — September 9, 2026

The user explicitly authorized deployment after reviewing the unrelated integration failures. Production now runs **`2f021c2698f41071e526308127ddaf2b6050c35e`**. The source was deployed through compatible Release A **`00baf02b29e30ccb7c964c493d2d4d76405c2b4a`** before Release B. Both releases used the existing locked PM2 wrapper; the old HTTP, cron and resolution writer processes exited. The rollback target is Release A, retaining the additive wardrobe schema and saved outfits.

The final production verification completed at **2026-09-09 23:23:42 UTC**:

- Migration `20260909190000_character_wardrobes` applied successfully at 23:15:20 UTC.
- Projection reconciliation checked 1,472 users in eight bounded pages, found zero mismatches, and confirmed zero again. No projection repair writes were necessary.
- The reviewed fit manifest validated and installed exactly 56 accessory/character pairs, with no missing catalog identities. No retirement, ownership, price, artwork or flag changes were made.
- The post-migration catalog audit checked 69 items and 229 purchase replays; no missing tables, active mismatches or remaining page were reported. Birthday Hat remains released and owned by the previously requested account.
- Actual production requests returned 200 for legacy catalog/powerups, the new three-character collection, both production and TestFlight wardrobe reads, and repeated public friend reads. Both new mutation routes returned the expected 400 for malformed bodies. Equipped appearance remained unchanged.
- Exactly two HTTP workers, one resolution worker and one cron worker are online; staging is stopped. The final guarded pool aggregate is 32. Environment, ecosystem configuration and the preexisting server-local package-lock file retain their original hashes.
- Required referral catch-up applied zero missing records; final race-activity and review-ownership counts are both zero.

The historical migration-check CLI expected a `PROD_DATABASE_URL` key absent on the server. An equivalent read-only migration inventory used the configured production connection and confirmed no unfinished migrations before applying the additive migration. The balance report retained three existing DECOY configuration differences; no economy changes were made. Its completed CLI overlapped a follow-up invocation, resulting in two serialized guarded reloads of identical A source; both completed safely. B used one guarded reload.

Source tags `character-wardrobe-release-a-20260909` and `character-wardrobe-release-b-20260909` are pushed. Remote `main` points to the deployed B commit. This evidence-only branch adds no runtime changes and is not a different deployed application revision.

Full integration remains documented as red; deployment authorization accepted the unrelated failures without changing or weakening those assertions. See `character-wardrobe-release.md` and the exact candidate baseline-comparison evidence for those limitations. The production results and process evidence are retained in `docs/evidence/character-wardrobe-production-deployment.json` and on the server under the dated release evidence directory. No staging service was started.
