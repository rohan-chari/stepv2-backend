# barastep.com — notes batch (2026-08-10)

Follow-up to `marketing-site-rebuild-requirements.md`. Six changes taken from a
Notes screenshot after the first version of the site went live.

The rebuild spec's constraints all still hold and are not restated here:
`src/modules/web/theme.js` stays the only place a colour or typeface is defined;
every page must render its content with JavaScript disabled (the prerender
step); nothing may reference `/assets/` (the CDN art mount) from the built site.

## The notes, verbatim

1. "Change this to say Bara: Step Challenges and put the logo to the left of it."
   (pointing at the `Bara` wordmark in the site header)
2. "Change header to 'Step challenges are more fun when you can steal steps from
   someone'"
3. "Use the font that the 'Bara' text is in on the homepage when u first download
   the app. The bara logo/name at the top should also be in that font to keep it
   consistent"
4. "Do you think you could put a phone icon with a screenshot (example below) of
   the gameplay (maybe like text saying 'you stole 1000 steps from XYZ' or
   something showing a powerup being used with text" (example: the Clash of
   Clans store page — phone at left, headline + body + store badges at right)
5. "Could you also change the App Store button to look like that one^ no biggie
   if it's too hard"
6. "Also it would be cool to add in live reviews (as long as they're 5 stars) as
   like a scrolling left to right widget that's constantly moving. U may need a
   3rd party widget like Elfsight, SociableKIT[…]" (the note is cut off here)

## 1–3. Wordmark and headline

**The font is Jersey 25.** The app's title-screen wordmark is
`PixelText.display` (`lib/styles.dart:669`), which is `fontFamily: 'Jersey25'` —
a true bitmap-pixel face, bundled in the app rather than fetched so a cold
offline first launch still gets it. It is also on Google Fonts as `Jersey 25`,
so the site loads it through the existing `FONT_LINK_TAGS` in `theme.js` with no
new hosting and no new origin in the CSP.

It gets a fourth token role, `--font-wordmark`, rather than replacing
`--font-display`. Two reasons, both from the app's own notes:

- Jersey 25 has a very small x-height and stepped letterforms, so it "only reads
  well large" (`styles.dart:660`). The app never sets it below 30px. Body copy
  and section headings stay on Bricolage Grotesque.
- The hero headline in note 2 is 63 characters. Setting that in a pixel face at
  hero scale would wrap to four or five lines of low-legibility type on a phone.

So Jersey 25 is used for the wordmark (site header, site footer, and the three
server-rendered share-link pages) and nowhere else. This is a deliberate
narrowing of note 3, which asked only for "the bara logo/name at the top".

**The wordmark becomes `logo + "Bara: Step Challenges"`.** The logo is the app
icon already served at `/icon-192.png`. It is referenced by absolute path, not
bundled, so the identical markup works from the Vite site and from the runtime
landing-page shells.

The full string will not fit beside the nav on a narrow phone in a display face.
It is set as two spans: `Bara` always visible, `: Step Challenges` revealed
above a threshold. The accessible name is always the full "Bara: Step
Challenges" via the link's `aria-label`, so what a screen reader announces does
not change with viewport width.

That threshold is **420px in the site header and 360px on the share-link
pages**, and the difference is deliberate: the header has to fit three nav links
on the same row, while a share page centres the wordmark on a line of its own.
A share link is the branding surface most people meet first, so it shows the
full name at every width that can hold it. Measured at 320/360/430/501/600px,
the share-page lockup fits its 430px column at all of them.

**Hero headline** becomes note 2's sentence verbatim. The existing eyebrow and
subheading are re-cut to sit under it without repeating it.

## 4. Phone mockup

A device frame at the left of the hero on desktop, above the copy on mobile,
holding a gameplay moment: a race leaderboard mid-race with a Leech powerup
event reading "You stole 1,240 steps from Marcus".

**This is a composed mockup, not a screen capture.** It is built from the app's
real powerup PNGs (already vendored into `web/src/assets/`) and the real capybara
walk sprite, laid out in HTML to match the app's race screen. The device frame
itself is CSS chrome, which `CLAUDE.md` permits; no artwork is hand-drawn.

The honest alternative — a real screenshot — needs a signed-in account in a race
with live data, and every such screenshot to date has carried real usernames
(see the App Store screenshot PII note). A composed frame using shipped art
carries no PII and cannot leak a real player. **Open item:** if a real
screenshot is preferred, it drops into the same slot as a single `<img>`; the
names in the mockup are fictional and must stay fictional.

## 5. App Store badge

Apple's official "Download on the App Store" badge, fetched as SVG from
`tools.applemediaservices.com` and vendored to
`web/src/assets/app-store-badge.svg`. It is Apple's own artwork, so the
proportions, wordmark, and Apple logo are correct by construction rather than
redrawn.

Guideline compliance: rendered at 48px tall (Apple's minimum is 40px), never
recoloured, never stretched, with clear space of at least 1/10 its height. The
badge is a link to the App Store URL and carries an `alt` of "Download on the
App Store".

The Google Play badge is deliberately **not** added — the app is not on Play, and
the site's whole Android story is the waitlist. The waitlist CTA sits beside the
badge instead.

## 6. Live 5-star reviews

**No third-party widget.** Elfsight/SociableKIT would mean a remote script tag
on every page: a new origin, a render-blocking dependency, a third party
receiving every visitor's IP and user agent, and a recurring cost — for data
Apple already publishes for free.

Instead, the backend proxies Apple's public customer-reviews RSS feed.

### API

`GET /reviews/ios`

Response `200`:

```json
{
  "reviews": [
    { "id": "12876543210",
      "title": "This app slays",
      "body": "I have never walked so much in my entire life.",
      "author": "Bara lover 101",
      "rating": 5 }
  ]
}
```

- Only `rating === 5` entries are returned. Anything else is dropped server-side,
  so a 1-star review can never reach the page even if the client is wrong.
- The feed's first entry is the app record, not a review; entries without an
  `im:rating` are skipped.
- Bodies are truncated to 240 characters at a word boundary.
- Cached in memory for 6 hours. On a fetch failure the last good payload is
  served regardless of age; if there has never been one, `{"reviews": []}` with
  a `200`. **The marketing page must never 500 because Apple is down.**
- Fetch timeout 5s. The cache is per-process, so a 2-worker pm2 cluster makes at
  most 2 upstream calls per 6h window.

### Rendering

The marquee is a CSS `translateX` animation over the list duplicated twice, so it
scrolls continuously with no visible reset. It is **not** interactive: no
pause-on-hover controls to keyboard-trap, and the whole strip is
`aria-hidden="false"` with the reviews as a plain list underneath the animation
so assistive tech reads a static list.

`prefers-reduced-motion: reduce` stops the animation and the strip becomes a
horizontally scrollable row.

**Reviews are user-generated text from a third party.** They are rendered
through Vue text interpolation and the prerenderer's `renderToString` — both
escape — and never through `v-html`.

A snapshot of the reviews at build time is prerendered into the HTML, so the
section is populated with JS disabled and if the runtime fetch fails. The client
replaces it on mount when `/reviews/ios` answers.

## Backward compatibility

Nothing here is consumed by the iOS app. `/reviews/ios` is a new public GET; no
existing route, response shape, or DB table changes. There is no migration.

The two shared strings that live in more than one file — the Play-store alert and
the wordmark markup — are covered by the existing landing-page assertions.

## Test plan

Extending `test/integration/android-waitlist.test.js` (renamed to
`marketing-site.test.js`, since it now covers more than the waitlist):

- `/reviews/ios` returns only 5-star entries, given a stubbed feed containing a
  3-star one.
- A feed entry with no `im:rating` (the app record) is skipped.
- An upstream failure with a warm cache serves the cached payload.
- An upstream failure with a cold cache returns `200 {"reviews": []}`, not a 500.
- A second request inside the cache window makes no second upstream call.
- The home page's prerendered HTML contains the headline from note 2, the full
  "Bara: Step Challenges" accessible name, and at least one review body — all
  with JS disabled.
- The App Store badge SVG and the logo both resolve (no 404s).

`web/scripts/check-build-output.mjs` gains: the new headline is in the required
prose map, and the built pages must reference the Jersey 25 family (so a future
edit to `FONT_LINK_TAGS` that drops it fails the build rather than silently
falling back to a system face).

## Acceptance criteria

- Header reads "Bara: Step Challenges" with the app icon to its left, in Jersey
  25, on all three site pages and the three share-link pages.
- Hero headline is note 2's sentence.
- Hero shows a phone frame with a powerup/steal moment and the official Apple
  badge.
- A continuously scrolling row of real 5-star App Store reviews, populated with
  JS off.
- No third-party script origin is added to any page.
- Existing routes, OG tags, and the waitlist all behave as before.

## Second notes pass (2026-08-10, later the same evening)

A follow-up screenshot pair reversed two decisions from the first pass and
tightened the page:

- **Headings move to Jersey 25 and go black.** The first pass deliberately kept
  the hero on Bricolage, reasoning that a 63-character headline in a bitmap face
  would be unreadable. Rendered, it is not — Jersey 25 is condensed enough to
  carry the full sentence in three lines at 5.5rem. `--font-wordmark` now also
  sets the hero `h1` and the section `h2`s. The green accent spans are gone;
  headings are `--paper-foreground` throughout, and the small mono eyebrows are
  the only coloured text left.
- **The phone mockup is removed** ("looks a little weird and takes up a lot of
  space"). `PhoneMockup.vue` is deleted rather than left unused, along with the
  five powerup PNGs and the coin that nothing imports any more. The open item
  about swapping in a real screenshot is closed — there is no slot for one.
- **New hero subcopy**, supplied verbatim.
- **The dashed rule is replaced by the app's actual trail.**
  `assets/images/home_hero_ground.png` — the same ground strip the app's home
  screen walks along, grass lip over dirt blocks, no grandstand (the note asked
  for it "without the bleachers in the back", which rules out
  `race_day_course.png`). It runs full-bleed rather than inside the content
  column, so the capybara now walks the whole viewport.
  - The art is 1350x164 and does **not** wrap seamlessly (best repeat period
    scores well above zero), so it is drawn at an exact 2:1 downscale — 82px
    tall, 675px per tile — which both hides the repeat on most viewports and
    keeps the pixels on a clean integer ratio.
  - The walk sprite carries **14px of transparent padding below the feet** in
    its 64px cell, so aligning the element box to the grass leaves the animal
    hovering. The `bottom` offsets are derived from that padding and the
    measured grass line; the arithmetic is written out in `HomePage.vue`.
- **The "Walk. Compete. Keep them guessing." section is removed** entirely.
- **The powerup grid is respecified** to Runner's High, Wrong Turn, Protein
  Shake, Stealth Mode, Trail Mine, Rainstorm, in that order. Copy is the
  backend's own catalog text (`powerupCopySeed.js`), trimmed — so the page
  cannot promise a duration the game does not apply.
- **A Google Play mark replaces the coin** beside "Android". It is the icon, not
  the "Get it on Google Play" badge, deliberately: the app has no Play listing,
  and a store badge would advertise one. Drawn as inline SVG
  (`GooglePlayMark.vue`); swap in Google's official asset if exactness ever
  matters.

## Revision log

- **2026-08-10 — Code review (verdict FIX FIRST), all items resolved.**
  Two real defects:
  1. **The marquee track held ONE copy of the list, so it snapped every loop.**
     `while (out.length < MIN_ITEMS) out.push(...fiveStar)` pushes once and
     exits at 14 ≥ 8, but the CSS translates `-50%`, which is only seamless if
     the track is exactly two identical halves. The track is now built as
     `[...half, ...half]` with the duration timed off the half, and
     `check-build-output.mjs` asserts on the SHIPPED html that the card count is
     even and the two halves are byte-identical (modulo Vue's SSR fragment
     anchors). Verified the guard fails when the track is truncated to one copy.
  2. **`/reviews/ios` re-hit Apple on every request while Apple was down.** The
     failure path never wrote the cache, and a cold cache is the normal state
     after each pm2 reload — so an upstream outage turned every visitor into a
     5s outbound fetch on the one-vCPU droplet. Added a 5-minute negative-cache
     window and in-flight request coalescing, both covered by tests.

  Also fixed: `wordmarkHtml()` hardcoded `barastep.com` (staging's logo would
  have linked to prod) — it is now a non-interactive `role="img"` lockup, which
  also restores the non-link semantics of the `<h1>` it replaced; the wordmark
  gained `max-width:100%`/`min-width:0` and a 400px size step because
  `display=swap` paints the WIDER fallback face first, so sizing that only fits
  once Jersey 25 lands overflows on every cold load; `npm run dev` no longer
  fetches the network and rewrites a committed file; the app id is derived from
  `sharing.APP_STORE_URL` rather than duplicated. The `/reviews/ios` integration
  test was asserting nothing on an empty list — it now injects a stub feed
  through the router's existing DI seam and proves over real HTTP that 1-, 3-
  and 4-star entries never reach the response.
- **2026-08-10 — Implementation + UI-placement review.** Wordmark threshold split
  420px/360px (above). Header nav tracking and wordmark size step down below
  380px — at 320px the old sizing pushed "Privacy" off-screen, which the
  measurement sweep caught. The invite headline on all six share-link variants
  was promoted from `<div>` to `<h1>`: replacing the old `<h1>Bara</h1>` with a
  wordmark link would otherwise have left those pages with no heading at all.
  `check-build-output.mjs` gained the Jersey 25 assertion and it fired
  immediately — the three entry HTML files hand-write their own font `<link>`,
  a second drift surface alongside `theme-color`.
- **2026-08-10 — Draft.** Written from the Notes screenshot. Note 6's text is cut
  off mid-sentence in the screenshot; the visible part names two widget vendors,
  and this spec deliberately declines both in favour of a first-party proxy.
  Note 3 is narrowed to the wordmark only, for the legibility reason above.
  Note 4 is a composed mockup rather than a capture, pending a real screenshot.
