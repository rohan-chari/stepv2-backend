# Shop billing repair — backend and store verification, 2026-09-10

## Contract lock

The existing `bara-billing-v1` contract remains unchanged. This repair changes no
backend endpoint, response shape, status code, migration, product identifier,
price, grant, realm rule or fulfillment behavior. Current deployed backend runtime
is `3a60332` per the orchestrator's production audit. No backend runtime change or
deployment is needed for the UI/native-loading repair. No backend tests were added
or run because no backend behavior changed; this is configuration verification.

Old binaries retain the same billing contract and existing catalog identifiers.
Native checkout continues to require backend-approved identifiers and prices from
the store; the app does not grant coins. Sandbox/production identities and the
existing idempotent server fulfillment remain authoritative.

## Live ASC and RevenueCat evidence

Bounded authenticated reads used the existing ASC API key referenced by ignored
frontend `.env`; the private key stays outside the repos. Credentials, generated
JWTs, customer identities and financial balances were not printed or committed.

At 12:37 UTC, each of these products had 175 configured territories including USA,
with no further pages. Current US manual prices had no start or end date:

| Product | Apple ID | US price | en-US localization before repair |
| --- | --- | --- | --- |
| `bara_coins_500_v1` | `6809896890` | $0.99 | Present |
| `bara_coins_2800_v1` | `6809901675` | $4.99 | Present |
| `bara_coins_6000_v1` | `6809902519` | $9.99 | Missing |
| `bara_plus_permanent_v1` | `6809902992` | $19.99 | Present |

The explicit registered bundle `com.rohanchari.steptracker` has the
`IN_APP_PURCHASE` capability. RevenueCat's configured iOS app has the three coin
identifiers, `bara_plus_monthly_v1`, and `bara_plus_permanent_v1`, with their correct
consumable/subscription/non-consumable types. All four non-subscription ASC products
reported `MISSING_METADATA`; this status alone does not establish a sandbox blocker.

Apple's [sandbox troubleshooting note](https://developer.apple.com/documentation/technotes/tn3186-troubleshooting-in-app-purchases-availability-in-the-sandbox)
explains that TestFlight uses the sandbox, product lookup requires configured price
and localization, and review submission is not necessary for sandbox testing.
Agreement/bank/tax/capability/signing conditions are additional possible causes.

## Applied metadata correction

The orchestrator authorized the following minimal correction under the owner's
explicit request to repair unavailable coin packs. Immediately before creating,
the script re-read the existing product/type and its localization list. It would
verify rather than overwrite an already-existing en-US localization.

At **12:38:56 UTC**, `POST /v1/inAppPurchaseLocalizations` created:

```json
{
  "data": {
    "type": "inAppPurchaseLocalizations",
    "attributes": {
      "locale": "en-US",
      "name": "6,000 Coins",
      "description": "6,000 coins for powerups, cosmetics & rerolls"
    },
    "relationships": {
      "inAppPurchaseV2": {
        "data": {"type": "inAppPurchases", "id": "6809902519"}
      }
    }
  }
}
```

Returned localization ID: `e24bcb60-17e9-44a3-b1ca-b14a8194b098`.
A second GET verified the exact fields and `PREPARE_FOR_SUBMISSION` localization
state. Name length is 11 and description length is 45, satisfying Apple's
[localization limits](https://developer.apple.com/help/app-store-connect/reference/in-app-purchases-and-subscriptions/in-app-purchase-information/).
An initial guard rejected the proposed description with a final period (46
characters) before any POST; the applied description omits that period.

Post-change reads confirm the product ID/type, all four current prices, and all
175 sale territories are unchanged. The overall product state remains
`MISSING_METADATA`. No other metadata, price, agreement, bank, tax, product review
submission or production backend state was deliberately changed.

## Native availability and public backend verification

The orchestrator's real StoreKit2 `Product.products(for:)` probe at 12:39:09 UTC
returned 500 and 2,800 coin products, monthly membership and permanent membership,
with their real prices, using the correct bundle and no local StoreKit fixture.
The 6,000 product was absent immediately after the localization correction; a
later native lookup must confirm propagation. These results establish native
availability for four products, not successful paid checkout or fulfillment.

Backend GET `/billing/bootstrap` is not strictly read-only: it attempts idempotent
identity/reconciliation inserts, and authentication may update normal activity
metadata. The orchestrator explicitly authorized one normal diagnostic app GET,
not an integration harness, fixture or manual account mutation. A bounded
`BEGIN READ ONLY` SELECT first verified the configured admin already had both
records; the probe would stop if either was absent. The request used no feature,
version, timezone, purchase or sync headers/body. A request at 12:40:28 UTC returned
401 with the local session secret; this does not establish billing unavailability.
No customer payload was logged. A subsequent request signed with the runtime secret
in memory returned **HTTP 200 / `available:true` / `bara-billing-v1` at 12:42:19 UTC**.
Its five returned IDs exactly match ASC/RevenueCat: the three coin packs, monthly
membership and permanent membership. Existing identity/reconciliation records were
checked again before this successful request. The existing billing identity was
saved only in an ignored owner-readable local file for the orchestrator's native
RevenueCat probe; it was not printed or committed. No purchase/sync call was made.
The failed first request used a local secret; no secrets were copied or changed.

Temporary read-only scripts and sanitized reports are under the local temporary
`bara-shop-billing-assessment` directory. No credentials are embedded in them.

## Final native propagation check

At12:44:11UTC the orchestrator’s real AppleStoreKit2 and pinnedRevenueCat native
SDK both returned allfive configured products with localized prices, including
6000coinsat$9.99. Monthly introductory eligibility lookup completed. No StoreKit
configuration file, intercepted network responses or purchase/restore/sync calls
were used. Temporary existing-identity probe file and disposable simulator were
removed afterward. Frontend evidence: docs/artifacts/shop-billing-repair-2026-09-10/.
This verifies product availability, not paid checkout or server fulfillment.
