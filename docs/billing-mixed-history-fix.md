# Billing mixed-environment history fix

A RevenueCat customer can retain sandbox purchases from TestFlight alongside live purchases. The provider previously rejected the entire history on the first opposite-environment record, so real purchases never reached fulfillment.

The provider now checks ownership and recognizes only production/sandbox environments, then skips known opposite-environment purchases and subscriptions before product resolution. Missing/unknown environments and ownership mismatches remain errors. It still follows all pages. Transaction hints for excluded purchases remain pending rather than appearing fulfilled.

Canonical receipt keys, coin ledger deduplication, refund logic, account realms, API contracts and product grant amounts are unchanged. Both iOS and Android use the same fix. Older app versions require no update; no migration, flag or new configuration is needed. DrAmogh's two manually recovered purchases already have canonical fulfilled receipts and will not be credited again.

The change adds no database queries or writes. It avoids product lookups and subscription transaction fetches for excluded history, and lets valid mixed-history reconciliations complete instead of continually retrying.

## Validation

- New real HTTP/DB integration suite: 11 cases, with 5 correctly failing with BILLING_REALM_MISMATCH before the change; all 11 pass afterward.
- Both platforms and realms, paginated mixed history, duplicate synchronization, refund replay, opposite-only pending hints, invalid environments and foreign ownership covered.
- Broader billing integration suites: initially 91/92 passed; reviewer seed test lacked local Redis. All 13 tests in the affected realm suite passed when rerun with dedicated local Redis. No assertions weakened.
- Existing provider tests: 5/5 passed.
- Flutter analyze: clean. No Flutter/native code changes or builds.
- Independent code reviewer: SHIP, no blockers.
- Dedicated local steps_billing_mixed_test database, fully migrated; no production test writes. The pre-existing shared integration database had an unrelated duplicate-index migration conflict.

## Production deployment

Explicitly authorized and deployed as runtime `0b9b1b7`, isolated on top of production `b20ad0b`; only this fix, regression tests and this report changed. Exact release artifact: 16/16 billing regression/provider tests passed against the dedicated local test database after applying its existing migrations.

Guarded PM2 reload completed: two HTTP workers, one resolution worker, one cron worker, staging stopped, aggregate pool budget 32. Production health and Redis returned OK. No production migrations, dependency installation or configuration changes; existing environment and modified package lock preserved.

Two authenticated live billing syncs for the affected account returned HTTP 200 / complete. Both retained the pre-verification balance of 8,474 coins; ledger total also 8,474, exactly two purchase-credit entries, and reconciliation last_error is null. The earlier recovery balance was 8,624; intervening account activity occurred before verification, not during either sync. No duplicate purchase credits were issued.
