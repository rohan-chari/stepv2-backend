# Marketing site rebuild (Vue + shadcn-vue) + Android waitlist — requirements

## Summary & user story

`barastep.com` is currently three hand-written static HTML files
(`public/index.html`, `public/privacy.html`, `public/support.html`, each ~700
lines with a full duplicated `<style>` block) served directly by Express
(`src/app.js:326-330`), plus three server-rendered "share link" landing pages
(`src/modules/web/{race,referral,tournament}LandingPage.js`) that render raw
HTML strings for `/r/:token`, `/f/:code`, `/t/:token` link previews.

As the marketing owner, I want:
1. The static marketing pages (home, privacy, support) rebuilt with Vue 3 +
   Vite + shadcn-vue so future edits are component-based instead of editing a
   duplicated inline `<style>` block three times — while still deploying as
   plain static files Express serves exactly as it does today.
2. A **new Android waitlist** capture on the marketing site (the app is
   currently iOS-only — no Android build exists yet, see `sharing.js`'s
   `PLAY_ALERT_MSG` and the memory note that Android is blocked on Play
   Console / OAuth clients).
3. The three server-rendered share-link pages **restyled** to match the new
   site's visual theme, without changing their runtime behavior (still
   server-rendered per-request HTML with OG tags for link unfurling).
4. Everything else — routes, deep-link files, `app-ads.txt`, `share-card.png`,
   content/copy of privacy & support — **stays exactly as it behaves today.**

## Scope / non-goals

**In scope**
- New `web/` Vite + Vue 3 + shadcn-vue project in the backend repo, building
  to a static `dist/`.
- A new **shadcn-based visual theme** (not literally the app's AppPalette, not
  the share pages' wood/trail look — a fresh design built with shadcn-vue's
  theming conventions, on-brand for Bara). This is the single theme the new
  Vue site AND the restyled share-link pages will both use.
- Rebuild of home (`/`), privacy (`/privacy`), support (`/support`) as Vue
  routes/pages with the same copy/content as today (this is a visual +
  tooling rebuild, not a copy rewrite).
- New Android waitlist: one email field, a new DB table, a new POST endpoint,
  a section/page on the marketing site. Retrieval is by direct DB query (no
  export tooling, no confirmation email, no admin endpoint).
- Restyle (CSS/markup only) of the two existing `shell()` functions —
  `raceLandingPage.shell` (shared by `raceLandingPage.js` and
  `tournamentLandingPage.js`) and `referralLandingPage.shell` — to the new
  shared theme. If the Android waitlist CTA replaces the disabled-Play-button
  affordance on these pages, both `PLAY_ALERT_MSG` copies (or their
  replacement) must change together.
- Express serves the built `web/dist/` static output in place of today's
  `public/index.html` etc. `public/` keeps owning `assets/`, `app-ads.txt`,
  `share-card.png`, and the deep-link `.well-known` files — those do not move
  into `web/`.

**Non-goals / explicitly unchanged**
- No change to `/r/:token`, `/f/:code`, `/t/:token` route behavior, their
  OG-tag/link-unfurling mechanics, or their being server-rendered HTML
  strings (NOT folded into the Vue SPA — a Vue SPA cannot produce per-request
  OG tags server-side without SSR, which is out of scope).
- No change to `/.well-known/apple-app-site-association`,
  `/.well-known/assetlinks.json`, `app-ads.txt`, `share-card.png`.
- No change to privacy/support page **copy** — same legal/help text, new
  presentation only.
- No SSR, no Node-side Vue runtime. The deployed artifact is static files;
  the Express process's only new responsibility is serving a different
  static directory.
- No email confirmation flow, no waitlist admin UI/export endpoint.
- No changes to the Flutter app.

## Current state (cited)

- `src/app.js:301-341` — `publicDir = public/`; `express.static` for
  `/assets`; explicit `sendFile` routes for `/`, `/support(.html)`,
  `/privacy(.html)`, `/share-card.png`, `/app-ads.txt`.
- `public/index.html`, `public/privacy.html`, `public/support.html` — each a
  full standalone HTML document with an inline `<style>` block porting
  `lib/styles.dart` AppPalette tokens (`--surface`, `--ink`, `--sage`,
  `--pill-gold`, etc.), duplicated identically across all three files per the
  comment at `public/index.html:20-26` ("there is no shared stylesheet route
  to link").
- `src/modules/web/raceLandingPage.js` exports `shell`, `pageScript`, and
  `escapeHtml`. `tournamentLandingPage.js` imports and reuses all three
  verbatim (`tournamentLandingPage.js:23-26`) — it does **not** have its own
  shell. `referralLandingPage.js` defines a **second** `shell` function
  (still importing `escapeHtml` from `raceLandingPage.js`). So there are
  **two** shells to restyle, not three: `raceLandingPage.shell` (shared by
  race + tournament) and `referralLandingPage.shell`. The restyle must keep
  this export/import seam — do not fork `raceLandingPage.shell` into a third
  copy for tournaments. Both shells use the same "Bara trail" token set
  (`--wood-shadow`, `--sky-top`, `--grass`, `--pill-gold`), different from
  the AppPalette tokens `index.html` uses today. All user-controlled
  interpolation goes through `escapeHtml()` — this pattern must be
  preserved, and both shells' existing test suites (`test/http/
  raceLandingPage.test.js`, `test/http/tournamentLandingPage.test.js`) must
  keep passing unmodified — see "Test plan" below.
- `PLAY_ALERT_MSG` (the "Google Play isn't live yet" copy shown when the
  disabled Play button is tapped) is defined independently in **both**
  `raceLandingPage.js:29` and `referralLandingPage.js:23` (duplicated, not
  exported from `sharing.js`) and injected into each page's inline script at
  `raceLandingPage.js:165` / `referralLandingPage.js:168`.
- `src/modules/web/sharing.js` — central config (`PUBLIC_BASE_URL`,
  `APP_STORE_URL`, `PLAY_STORE_URL`, `OG_IMAGE_URL`, etc.), consumed by the
  landing pages. `PLAY_STORE_URL` already exists (points at a Play listing
  that isn't live) — reusable for the waitlist CTA copy ("Android — join the
  waitlist" instead of a broken Play Store link).
- `prisma/schema.prisma` — no waitlist-shaped table exists. `LinkOpen`
  (`prisma/schema.prisma:1670-1697`) is the closest precedent for a simple,
  anonymous-write, no-auth-required public table (UUID id, `createdAt`
  default `now()`, indexed).
- No Node/Vue build tooling exists anywhere in the repo today — `package.json`
  has zero frontend build dependencies. Node is v24.16 (`.nvmrc` absent,
  confirmed via `node -v`).
- Deploy is manual SSH per `DEPLOYMENT.md`/`DEPLOY_RUNBOOK.md`: `git pull &&
  npm install && npx prisma migrate deploy && npx prisma generate && node
  prisma/seed.js && pm2 restart`. No CI/CD pipeline exists to hook a build
  step into.

## API contract

### `POST /waitlist/android`

New, unauthenticated, public (called from the marketing site, not the app).

**Request**
```json
{ "email": "person@example.com" }
```

**Response — 200 OK (always, whether new or already on the list)**
```json
{ "ok": true }
```
The spec originally split this into `201`/duplicate-`200` with an
`alreadyOnList` flag; dropped in favor of a single `200 { ok: true }` for
every successful submission, since the UI shows identical copy either way
and there's no reason to let the response shape leak whether an address is
already on the list.

**Response — 400 Bad Request**
```json
{ "error": "Invalid email", "code": "WAITLIST_INVALID_EMAIL" }
```
Returned when `email` is missing, not a string, fails a basic
`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` shape check, or exceeds 254 characters. No
MX/deliverability check (out of scope — matches the rest of the codebase's
validation depth for public inputs). Thrown as a `ValidationError` (see
`src/shared/errors/AppError.js`) inside an `asyncHandler`-wrapped route
handler, so the existing `errorMiddleware` (mounted last in `src/app.js`)
is what actually produces this `{ error, code }` body — the route itself
just throws.

**Rate limiting / anti-spam**: `src/app.js` has no general-purpose
rate-limiting middleware today (verified — only `cors`, `compression`,
`express.json`, and the header extractors are mounted ahead of the routes).
This endpoint does not introduce one either; the domain is already
Cloudflare-proxied (`src/app.js:310-315`'s comment), so a Cloudflare rate
rule on `POST /waitlist/android` is the zero-code answer if spam becomes a
real problem — worst case today is junk rows in a table nothing else reads.

### Code placement

Follow the existing module-per-domain shape (`src/modules/web/` today has
only renderers + `sharing.js` — no router, no commands, no models — so this
adds that shape rather than dropping a route into legacy `src/routes/`):

- `src/modules/web/waitlist/model.js` — the only file that touches Prisma;
  `addAndroidWaitlistEntry({ email }, { prisma })` — normalizes, inserts,
  catches `P2002` and returns the same success shape either way (see "Data
  model" below).
- `src/modules/web/waitlist/router.js` — `createWaitlistRouter(dependencies
  = {})` factory (DI seam: `dependencies.prisma || defaultPrisma`, same
  pattern as the existing `logLinkOpen` seam at `src/app.js:157`), validates
  the request body, throws `ValidationError` on bad input, calls the model,
  responds `200 { ok: true }`.
- Exported via `src/modules/web/index.js` alongside the existing renderers,
  mounted in `src/app.js` next to the other `app.use(...)` calls (near where
  `/assets` and the sharing-config-dependent routes are mounted).

**Compat with older app versions**: N/A — this endpoint is never called by
the Flutter app, only by the marketing site. No app-version compatibility
concern applies (CLAUDE.md rule #1 is about the mobile app / backend
contract; this is a web-only, backend-only surface).

### Existing routes — unchanged

`/`, `/support`, `/support.html`, `/privacy`, `/privacy.html` keep their exact
paths and `sendFile` semantics; they just serve files from a new location
(see "Static serving" below) with new content. `/share-card.png`,
`/app-ads.txt`, `/assets/*`, `/.well-known/*`, `/r/:token`, `/f/:code`,
`/t/:token` are untouched.

## Data model / migration

New additive table, modeled on `LinkOpen`'s shape:

```prisma
model AndroidWaitlistEntry {
  id        String   @id @default(uuid())
  email     String   @unique
  createdAt DateTime @default(now()) @map("created_at")

  @@map("android_waitlist_entries")
}
```

- `email @unique` is what makes "duplicate submission is not an error"
  possible — but only if the value is normalized first. `model.js` must
  `trim().toLowerCase()` the email before insert/lookup and store the
  normalized form (`Person@Example.com` and `person@example.com` must
  collide, not create two rows). The command attempts a create, catches
  Prisma's `P2002` unique-constraint error, and returns the same `200
  { ok: true }` instead of propagating a 500.
- Purely additive (new table, no touched columns on existing models) — safe
  to `prisma migrate deploy` on its own, no backfill, no interaction with any
  currently-shipped app binary.
- Follow `DEPLOYMENT.md`'s migration rules: run `prisma migrate dev --name
  add_android_waitlist_entries` against local/staging first, inspect the
  generated SQL, then `migrate deploy` per the normal deploy sequence — no
  special-casing needed since it's a plain `CREATE TABLE`.

## Frontend plan (marketing site)

### Project layout

```
stepv2-backend/
  web/                      # new Vite + Vue 3 + shadcn-vue source, own package.json
    src/
      pages/                # Home.vue, Privacy.vue, Support.vue
      components/           # shared nav, footer, waitlist form, ui/ (shadcn-vue primitives)
      theme/                # new shadcn-based design tokens, source-of-truth CSS vars
    vite.config.ts
    package.json            # separate from the backend's package.json — own deps (vue, vite,
                             # tailwind, shadcn-vue components), not installed by root `npm install`
  public/                   # UNCHANGED ownership: assets/, app-ads.txt, share-card.png,
                             # .well-known/* keep living here
```

- `web/` gets its own `package.json` (Vue/Vite/Tailwind/shadcn-vue deps do not
  belong in the backend's dependency tree — the running Express process never
  imports them). Root `npm install` on the droplet is unaffected.
- Build command: `cd web && npm install && npm run build`, output configured
  to `web/dist/`.
- Vite base path `/`; three static HTML entry points (`index.html`,
  `privacy.html` — wait, no: **use Vite's multi-page build**
  (`build.rollupOptions.input`) with three real `.html` entries — `index`,
  `privacy`, `support` — each its own Vue app instance mounted to a small
  root component, rather than a single SPA + vue-router. This matches the
  current architecture (three independent documents, no client-side routing,
  no history-mode fallback needed on the server) and requires zero Express
  route changes beyond the `sendFile` target directory.
- Shared chrome (nav, footer, waitlist CTA) lives as regular Vue components
  imported by all three page entries — no duplicated markup across the three
  pages, unlike today's three duplicated `<style>` blocks.

### Theme: single source of truth, two consumers

The Vue site (build-time Tailwind/CSS) and the two Express `shell()`
functions (runtime template strings) cannot literally share one CSS file —
one is compiled by Vite, the other is emitted by Node at request time. To
avoid recreating today's "two divergent inline theme systems" problem with a
third copy, the token values themselves live in exactly **one** place:

- `src/modules/web/theme.js` — a small CommonJS module exporting the new
  shadcn-based token set as a single `:root { --… }` custom-property string
  (plain JS object of `{ name: value }` pairs, with a helper that renders it
  to a `<style>` block). This is the source of truth.
- Both `raceLandingPage.shell` and `referralLandingPage.shell` `require()`
  this module and inject its `<style>` output directly — no copy-pasted
  token values in either file.
- `web/theme/tokens.css` (or a small build script that reads `theme.js` and
  emits a matching Tailwind config / CSS-vars file) is generated from — or
  kept byte-for-byte in sync with, if a generator is impractical for
  Tailwind's config format — the same values in `theme.js`. Whichever
  approach is used, a code comment in both files must point at the other so
  a future token change isn't made in only one place.

Acceptance criterion (see below) is scoped to this concrete mechanism, not
to a literal single shared CSS file.

### Pages / states

- **Home** (`/`): existing content (adventure/features board, nav to
  support/privacy) restyled with shadcn-vue components, plus a new **Android
  waitlist section** — email `<Input>` + `<Button>` (shadcn-vue primitives),
  three states:
  - idle: empty input, "Join the waitlist" button enabled.
  - submitting: button disabled + spinner, no double-submit.
  - success: input replaced with a confirmation message ("You're on the
    list" / "You were already on the list" — same copy for both `ok` and
    `alreadyOnList` responses, no need to expose that distinction to the
    user).
  - error: inline message below the input ("Enter a valid email"), input
    stays editable, no page reload (client-side `fetch` to
    `POST /waitlist/android`).
- **Privacy** (`/privacy`): same legal copy as `public/privacy.html` today,
  ported into a Vue page with the new theme's typography/layout.
- **Support** (`/support`): same copy as `public/support.html` today, same
  treatment.

### Static serving change in `src/app.js`

```js
const publicDir = path.join(__dirname, "..", "public");      // unchanged: assets, .well-known, app-ads.txt, share-card
const webDir = path.join(__dirname, "..", "web", "dist");    // new: built marketing pages

app.get("/", (req, res) => res.sendFile(path.join(webDir, "index.html")));
app.get("/support", (req, res) => res.sendFile(path.join(webDir, "support.html")));
app.get("/support.html", (req, res) => res.sendFile(path.join(webDir, "support.html")));
app.get("/privacy", (req, res) => res.sendFile(path.join(webDir, "privacy.html")));
app.get("/privacy.html", (req, res) => res.sendFile(path.join(webDir, "privacy.html")));
// unchanged: /assets, /share-card.png, /app-ads.txt still read from publicDir
```

Also add an `express.static` mount for `web/dist/assets/**` (Vite's own
hashed JS/CSS bundle output — distinct from the existing CDN `/assets` router
which serves game art; give Vite's asset dir a different mount path, e.g.
`/web-assets`, configured via Vite's `base`/`build.assetsDir`, so the two
`/assets` namespaces never collide).

## Backward-compat & rollout

- This is a web-surface-only change. It has zero interaction with any
  currently-shipped app binary — the Flutter app never requests `/`,
  `/privacy`, `/support`, or `/waitlist/android`. No `testOnly` gating, no app
  version compatibility concerns, no phased-rollout considerations.
- **`web/dist/` is committed to git**, not git-ignored. Rationale (reversing
  the earlier draft, which had `web/dist` built fresh on the droplet on every
  deploy and every rollback): `DEPLOYMENT.md`'s documented rollback procedure
  (`DEPLOYMENT.md:138-145`: `git checkout pre-X && npm install && npx prisma
  generate && pm2 restart`) has **no build step**, so a build-artifact-only
  `web/dist` would leave `/`, `/privacy`, `/support` serving a stale or
  missing (`ENOENT` → 500, including `/privacy`, the URL on the App Store
  listing) site on any rollback that follows the documented steps. Building
  fresh on a live one-vCPU droplet on every deploy is also real cost this
  site doesn't need to pay. Instead: build and verify `web/dist` locally,
  commit it like any other generated-but-tracked artifact, and the existing
  `git pull` + `pm2 restart` sequence (both deploy and rollback) just works
  with zero runbook changes to the rollback path.
- Deploy order: migration (`AndroidWaitlistEntry` table) → code (new route +
  committed `web/dist`) → restart. `DEPLOY_RUNBOOK.md`'s step 4 verify gets
  one addition: `curl -sI https://barastep.com/{,privacy,support}` alongside
  the existing `/health` check.
- Vite config: pin `base: '/'` and `build.assetsDir` to a **non-`/assets`**
  path (e.g. `web-assets`) — Vite's default `assetsDir` is `assets`, which
  collides with the existing CDN art router mounted at `/assets` with
  `fallthrough:false` (`src/app.js:316-324`); an unresolved collision 404s
  every JS/CSS asset the built site needs, silently rendering an unstyled,
  non-interactive page. Add a build-output check (grep the built HTML for
  literal `/assets/` references) before treating a deploy as verified.
- The share-link page restyle is a pure CSS/markup change inside the existing
  `shell()` functions — no route, response-shape, or OG-tag behavior change,
  so it carries zero compat risk and can ship in the same release as the rest
  of this work.

## Test plan

**Backend** (`test/`, integration-first per CLAUDE.md)
- `test/integration/waitlistAndroid.test.js`:
  - `POST /waitlist/android` with a valid new email → `200 { ok: true }`, row
    exists in `android_waitlist_entries` with the normalized email.
  - Same email submitted twice → second call also returns `200
    { ok: true }`, still only one row exists.
  - Same email in different case/whitespace (`" Person@Example.com "`)
    submitted after the lowercase form → treated as the same address, still
    one row (proves normalization, not just literal-string uniqueness).
  - Missing/malformed email, or one over 254 characters → `400
    WAITLIST_INVALID_EMAIL`, no row created.
  - Confirm existing routes (`/`, `/privacy`, `/support`, `/share-card.png`,
    `/app-ads.txt`) still return `200` after the static-serving change (guards
    against a `webDir`/`publicDir` path mistake breaking the deploy — this
    only catches a broken build if `web/dist` is committed and present in the
    checkout the test runs against, per the "committed, not git-ignored"
    decision above).
- Never point `test:integration` at prod/staging DB — per CLAUDE.md, confirm
  `DATABASE_URL` targets the `*_test`/integration DB before running.

**Existing tests this change must NOT weaken** (CLAUDE.md: never weaken or
delete an existing assertion) — `test/http/raceLandingPage.test.js` and
`test/http/tournamentLandingPage.test.js` assert markup-level details of
`raceLandingPage.shell` that the restyle must preserve exactly:
- `store-btn-disabled` class name present, `play.google.com` absent
  (`raceLandingPage.test.js`'s "Play button is disabled" test) — if the
  waitlist CTA replaces this disabled-button affordance on the share pages,
  this is the first assertion to check, and the test itself would need a
  deliberate, called-out update (not a silent weakening) to match the new
  behavior.
- `<!DOCTYPE html>` on the not-found page, the `og:image`/`twitter:card`
  present/absent branches, and both XSS-escaping tests (`&lt;script&gt;`
  entity-escaped, `"><img src=x onerror=y>` neutralized).
Run both suites after the restyle and confirm they pass unmodified; if the
CTA change genuinely requires updating the Play-button assertions, that
update must be explicit in the PR, not incidental.

**Web (`web/`)**
- No existing test tooling in the repo for a Vue project — this spec does not
  mandate standing up a full Vue testing stack for a marketing site (out of
  proportion to the risk: static content, no business logic beyond the
  waitlist form). Minimum bar: a manual check (below) covering the waitlist
  form's three states against a running local server, plus the backend
  integration test above proving the endpoint itself is correct. If the
  waitlist form's client-side logic grows non-trivial branching later,
  revisit with a real component test.

## Manual test plan (send this to the user before merge)

1. `cd web && npm install && npm run build`, then run the backend locally
   and hit `/`, `/privacy`, `/support` — confirm they load, look like the new
   theme, and existing nav links (`/support`, `/privacy`) work.
2. On `/`, submit the waitlist form with a valid email → see the success
   state, confirm a row landed in `android_waitlist_entries` (local DB).
3. Submit the same email again → still succeeds (no error shown to user).
4. Submit an empty/invalid email → inline error shown, no request state
   left disabled.
5. Hit `/r/<a real share token>`, `/f/<a real referral code>`, `/t/<a real
   tournament token>` — confirm they render with the new shared theme and
   still carry working OG tags (check via a link-preview debugger or curl +
   inspect `<meta property="og:...">`).
6. Confirm `/share-card.png`, `/app-ads.txt`, `/assets/manifest`,
   `/.well-known/apple-app-site-association`, `/.well-known/assetlinks.json`
   are all still `200` and byte-identical to before (these must be completely
   untouched by this change).
7. Resize/check the new theme at mobile widths (this is where the vast
   majority of real traffic — share-link opens — lands).

## Acceptance criteria / definition of done

- [ ] `web/` Vite+Vue3+shadcn-vue project exists, builds to `web/dist/` with
      three entries (`index.html`, `privacy.html`, `support.html`).
- [ ] New shadcn-based theme's token values live in exactly one source of
      truth (`src/modules/web/theme.js`), consumed by both
      `raceLandingPage.shell`/`referralLandingPage.shell` and the Vue site's
      build — not duplicated by hand in either direction.
- [ ] `src/app.js` serves `/`, `/support(.html)`, `/privacy(.html)` from a
      **committed** `web/dist/`; every other existing route/file is
      byte-identical in behavior. No literal `/assets/` reference in the
      built HTML (Vite `assetsDir` collision check).
- [ ] `POST /waitlist/android` implemented per the contract above (single
      `200 { ok: true }` response, normalized+length-capped email, DI'd
      Prisma access, `ValidationError` → `errorMiddleware` for 400s), with
      passing integration tests including the case-normalization case.
- [ ] `AndroidWaitlistEntry` migration applied to staging, verified, then to
      prod per `DEPLOYMENT.md`'s migration rules.
- [ ] `test/http/raceLandingPage.test.js` and `tournamentLandingPage.test.js`
      pass unmodified after the restyle (or carry an explicit, called-out
      update if the waitlist CTA intentionally changes the Play-button
      affordance).
- [ ] `DEPLOY_RUNBOOK.md` step 4 updated with the `curl -sI
      https://barastep.com/{,privacy,support}` check; rollback section
      needs no changes since `web/dist` is committed, not built on-box.
- [ ] Manual test plan above run and passing.
- [ ] `code-reviewer` agent run on the combined diff.

## Revision log

- **Draft**: initial spec from codebase exploration (app.js routing, the
  three static pages' duplicated-style comment, the three landing-page
  `shell()` functions and their divergent theme, `sharing.js` config,
  `LinkOpen` as the closest schema precedent, absence of any Node/Vue build
  tooling or CI pipeline).
- **Gap pass 1**: added the `email @unique` + `P2002`-catch design so the
  "duplicate is not an error" requirement is actually implementable; called
  out the Vite `/assets` vs. existing CDN `/assets` router name collision
  and resolved it with a distinct `/web-assets` mount; clarified `web/`
  needs its own `package.json` so Vue/Vite deps never enter the backend's
  runtime dependency tree; added the untouched-routes regression check to
  the integration test list.
- **Gap pass 2**: made explicit that CLAUDE.md's "never break older app
  versions" rule doesn't apply here (web-only surface, app never calls these
  routes) rather than silently omitting a compat section; added the
  `web/dist/` git-ignore + droplet-rebuilds-on-every-deploy rollback
  reasoning, since this repo has no CI to build artifacts for it; explicitly
  scoped down web-side testing (no Vue test stack mandated) with a stated
  reason, rather than leaving "test plan" looking incomplete; added the
  `DEPLOY_RUNBOOK.md` update as an acceptance item since the manual deploy
  runbook is the actual source of truth for how this ships in this repo.
- **Interview** (2026-08-10): user chose (1) a new shadcn-based theme rather
  than reusing AppPalette or the trail theme, (2) email-only waitlist
  retrieved by direct DB query (no export endpoint, no confirmation email),
  (3) `web/` lives inside the backend repo rather than a separate repo. Spec
  updated to match on all three.
- **Architect review** (2026-08-10, verdict REVISE, fully addressed):
  corrected two factual errors (there are two `shell()` functions to
  restyle, not three — `tournamentLandingPage.js` reuses
  `raceLandingPage.shell`; `PLAY_ALERT_MSG` lives duplicated in the two
  landing-page files, not in `sharing.js`); replaced the unachievable
  "theme defined once, re-exported into shell templates" plan with a
  concrete `src/modules/web/theme.js` single-source-of-truth mechanism;
  added explicit code placement for the new endpoint
  (`src/modules/web/waitlist/{model,router}.js`, DI'd Prisma, `AppError` +
  `errorMiddleware` for the 400) matching the module-per-domain shape
  instead of leaving it unspecified; added email normalization
  (trim+lowercase) and a length cap so `@unique` actually delivers the
  claimed idempotency and an unauthenticated endpoint can't write unbounded
  strings; dropped the 201/duplicate-200 split in favor of always
  `200 { ok: true }` since the UI never surfaced the distinction and it
  leaked list membership; reversed the git-ignored/build-on-droplet plan for
  `web/dist` to **committed to git** after finding the documented rollback
  procedure has no build step (would 500 `/privacy` — the App Store listing
  URL — on rollback); pinned Vite's `assetsDir` away from `/assets` to avoid
  colliding with the existing CDN art router; added explicit protection for
  the two existing landing-page test suites' markup-level assertions
  (`store-btn-disabled`, XSS-escaping, OG-tag branches) per CLAUDE.md's
  "never weaken an existing assertion" rule.
- **Implementation + code review** (2026-08-10). Built as specified, with four
  changes forced by the code review:
  1. **Pages are prerendered** (`web/scripts/prerender.mjs`). As first built,
     `dist/privacy.html` was a bare `<div id="app">` + module script, so
     /privacy — the URL on the App Store listing — rendered BLANK whenever the
     JS didn't load, while still returning 200. Vue now renders each page to a
     string at build time and the client `createSSRApp`s to hydrate it. Still
     no runtime SSR: the Express process serves static files only.
     `check-build-output.mjs` fails the build if a page ships without its copy,
     and an integration test asserts the served HTML contains real prose.
  2. **`assetsInlineLimit: 0`.** Vite inlines <4KB assets as data URIs, which
     leaves them out of the manifest the prerender pass uses to rewrite asset
     URLs — the 2.4KB capybara sprite silently became an unrewritable URL.
  3. **No HTML comments in Vue templates.** SSR emits them, the production
     client build strips them, and every page logged a hydration mismatch.
     Documented in each affected component so it doesn't come back.
  4. **`--destructive-text` token added.** `--destructive` (#E4593C) is 3.4:1 on
     `--card` — fine for fills, failing AA for the 14px inline waitlist error.
     The error text now uses a 5.07:1 token.
  Also from the review: `fallthrough:false` on the `/web-assets` mount to match
  the CDN mount; dropped the dead `theme` barrel export; the disabled Play
  button's alert now points at the new waitlist (no test asserted its text);
  and the unverified "Forty ways" marketing claim softened to "Dozens" rather
  than asserting a catalog count nobody checked.
- **Known deviation pending sign-off**: the HOME page copy was rewritten
  (new headline, powerup section, CTAs) rather than carried over verbatim as
  §Scope says. Privacy and support copy WERE preserved word-for-word. Flagged
  to the user rather than silently kept or reverted.
