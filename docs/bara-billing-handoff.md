# Bara billing resume point

## Main-branch save — September 8, 2026

The user explicitly requested committing and pushing the current work directly
to `main` for later resumption, while leaving deployment and ASC/Google Play/
RevenueCat setup for later. No new feature branch is required to resume billing.

Backend billing commit `4b4e563` was merged with upstream `409154a` in `867062d`.
The 18 incoming commits were retained; the only shared modified path was
`prisma/schema.prisma`, which merged additively without conflict. Independent
merge review: SHIP, no findings. Frontend implementation is `2afe99e`.

Post-merge checks:

- The 87-test billing/legal/upstream regression selection passed 84 initially;
  three upstream publication cases failed without a configured Redis instance.
  The complete affected five-test suite then passed 5/5 using a dedicated local
  Redis instance, which was stopped afterward. All selected billing cases passed.
- Full backend unit run: 3,366 passed, four failed, zero skipped (3,370 total).
  All four failures reproduced on unchanged upstream `409154a`: three cases in
  `localGlobalEventEntitlement.test.js` and the mutation-inventory assertion in
  `raceWriteFenceInventory.test.js`. This is not a green full unit result.
- Local test migrations applied and Prisma generation succeeded. No production
  database or service was changed. Frontend runtime code is unchanged from the
  earlier clean analysis, 3,061 passing tests and two native compile checks.
- Staged whitespace checks passed after Markdown hard-break normalization and
  removing extra terminal blank lines in two unshipped migration files.

Resume with `bara-billing-store-setup.md` and the manual UI checklist. Still
required: external product/credential setup, authorized backend deployment, real
store purchase acceptance, and matching signed release artifacts. Repository
push does not claim deployment or customer-release readiness.

The setup guide, API contract, full verification report and UI checklist are in
the frontend repository’s `docs/` directory.
