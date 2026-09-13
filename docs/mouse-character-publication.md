# Test-only mouse character publication — 2026-09-13

## Current revision: smoother artwork and animation

User subsequently requested less pixelated artwork and smoother animation, explicitly authorizing the CDN update. Asset commit `2d7d9c0` is deployed. Current CDN file: https://steptracker-api.org/assets/characters/mouse@109b9d1eb391.png . SHA-256: `109b9d1eb39186375752f29e233d677b19c7a80fb08907957f11f5e5010da2cd`.

The refined illustration preserves the gray/pink mouse identity with smooth contours. The horizontal sheet is now 1536×128: twelve distinct 128×128 poses instead of six 64×64 poses. Art was regenerated with the built-in image tool, chroma-cleaned, aligned to the stable head anchor with a common scale, and downsampled with Lanczos. Transparent borders and the editable Aseprite export round-trip passed.

Only `assetVersion` and `renderMetadata.animationFrames` changed on the existing catalog item. Baseline, placement metadata, price, availability, test-only/remote-only policy, and ownership were preserved; the same Rohan ownership row remains. Admin PATCH successfully mirrored to the peer database and invalidated catalog/manifest caches. The previous immutable PNG remains available for clients still using the old manifest.

Timing clarification: the app computes the displayed frame from animation-controller progress multiplied by the remote frame count. Its standard preview completes a cycle in 720 ms (other contexts can supply their own cycle duration); the original Aseprite file's 80 ms frame duration is not a universal app playback setting. The new editable source/preview uses 60 ms × 12 = 720 ms, matching the standard app preview. More poses improve temporal resolution within the existing cycle duration.

First/repeated live catalog reads passed for current TestFlight, current production, TestFlight without remote-art support, and legacy production. Only current TestFlight exposes Mouse, owned and activatable. Its manifest returns the new URL and twelve frames; the production manifest excludes it. CDN bytes matched the local hash before updating the catalog. Reviewer: SHIP. No Dart/runtime/config changes, restarts, migrations, ownership grants, or economy changes were made in this revision.

Revision-specific manual checks: reopen the test-channel app and confirm the new art loaded; inspect Shop/wardrobe and Home for consistent size/baseline, uncut ears/tail, no neighboring-frame bleed, and no body jumps at the loop boundary. Inspect existing race cards/detail/team/podium and leaderboard surfaces containing Rohan. Demo/tab fixtures and the default-capybara wardrobe tutorial do not contain Mouse and cannot validate this revision. Physical-device visual checks remain manual.

## Original publication record

User authorized publishing the generated mouse to the CDN and shop as test-only and granting it to the exact Rohan display-name account. Completed through the existing asset and admin catalog pipeline.

## Published content

- Asset commit: `b689cca` (pushed and fast-forwarded on the production checkout; only the new PNG changed).
- CDN: https://steptracker-api.org/assets/characters/mouse@a76ae5105dc5.png
- SHA-256: `a76ae5105dc51a4b25b4a967afb948d8475b179d286b8401fe244b6d0ec9b925`.
- SKU / asset key: `mouse`; name: Mouse; slot: CHARACTER.
- Catalog item ID: `6b60714d-49da-42fb-9d8d-4b1cec0756b1`.
- `active: true`, `testOnly: true`, `remoteOnly: true`, `earnOnly: false`, `bobble: false`.
- Base price: 1,000 coins, matching the existing Turtle. Existing membership pricing remains authoritative.
- Metadata: six frames, scale 1, offsets/rotation 0, baselineOffset -0.015625; 384×64 RGBA horizontal sheet. The one-pixel baseline lift aligns its feet with the capybara. Existing animation playback uses 80 ms per frame.

The public CDN response was checksum-verified before POST /admin/shop/items. The API reported successful peer mirroring. Staging service remained stopped. No app changes/builds, migrations, configuration changes, or process restarts occurred. Production retained exactly two HTTP workers and the existing resolution/cron processes, with unchanged PIDs. The pre-existing remote package-lock change was hash-preserved.

## Ownership and checks

Case-insensitive exact display-name lookup returned one account, Rohan. The grant pinned its ID and rechecked its display name under a user-row lock, validated the item under a shared lock, and inserted one unique user_shop_items record with ON CONFLICT DO NOTHING. Before-state and commit evidence are stored privately in the production host's root backup directory. Coins and current equipment were verified unchanged. No character was auto-equipped.

Live HTTP verification passed for first and repeated reads:

- TestFlight with characters + remote_assets: /shop/characters and /shop/catalog include Mouse; Rohan owns it and can activate it.
- Production with current capabilities: both catalogs exclude Mouse.
- TestFlight without remote_assets, and legacy production without capabilities: both catalogs exclude Mouse.
- /assets/manifest contains Mouse only for TestFlight, with the correct frame count, baseline and versioned URL.
- Rohan's Mouse wardrobe endpoint returns HTTP 200. No new accessory-fit approvals were created.

The existing test-only gate is release-channel based, not an account ACL. Public asset URLs remain public; the shop/manifest filtering controls normal app exposure. Older clients are protected by remoteOnly capability filtering on both iOS and Android. No carrying binary release is required.

Game analyst: SOUND for limited testing; zero minted coins or steps and zero spin/box EV change. Characters and test-only items are excluded from free accessory drops. One ownership grant avoids a purchase only for its recipient. Public-price affordability was not evaluated.

Code reviewer: SHIP, no blockers for catalog creation and the idempotent grant. Live execution and HTTP checks subsequently passed. Asset alpha, six distinct frames, checksum and Aseprite round-trip were verified; Flutter analysis was clean during art creation. No business logic changed and no integration tests were run against production.

## Manual UI placement checklist

Run on the TestFlight build as Rohan, on both supported platforms where a test-channel build is available:

1. Reopen Shop → Characters: Mouse appears once, owned; the tile shows one animated mouse rather than the full sheet.
2. Open its wardrobe: ears/tail stay in the preview and feet meet the baseline throughout the loop. Only backend-approved accessory fits should be offered.
3. Equip Mouse manually and return Home: character position is correct, with no clipping or duplicate body.
4. Inspect an existing individual/team race, race card, available results podium and leaderboard containing Rohan: the mouse stays inside its existing character slot, clear of text and other racers.
5. In a regular production-channel build, verify Mouse is absent from the shop, including when signed into the same account.

Demo race and tab tutorial reuse real screens but have separate fixtures; this catalog change does not inject Mouse into them. The wardrobe tutorial opens the default capybara. Profile-photo/initial widgets are independent of equipped character art. Device placement checks remain manual; API verification does not establish visual fit.
