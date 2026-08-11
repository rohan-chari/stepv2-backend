<script setup>
import SiteHeader from "@/components/SiteHeader.vue";
import SiteFooter from "@/components/SiteFooter.vue";
import WaitlistForm from "@/components/WaitlistForm.vue";
import ReviewsMarquee from "@/components/ReviewsMarquee.vue";
import GooglePlayMark from "@/components/GooglePlayMark.vue";
import { Button } from "@/components/ui/button";
import appStoreBadge from "@/assets/app-store-badge.svg";
import capySprite from "@/assets/capybara_walk_right.png";
import trailGround from "@/assets/trail_ground.png";
import runnersHigh from "@/assets/runners_high.png";
import wrongTurn from "@/assets/wrong_turn.png";
import proteinShake from "@/assets/protein_shake.png";
import stealthMode from "@/assets/stealth_mode.png";
import trailMine from "@/assets/trail_mine.png";
import rainstorm from "@/assets/rainstorm.png";

// Page order: hero -> the trail, walked by the game's real sprite on the game's
// real ground -> 5-star App Store reviews -> the powerups -> the Android
// waitlist.
//
// Headings are set in Jersey 25 (font-wordmark), the app's own title face, and
// are BLACK rather than the green accent — so the page reads as one voice with
// the app instead of two. The small mono eyebrows keep their colour; they are
// labels, not headings, and are the only thing left carrying hierarchy.
//
// NOTE: keep HTML comments OUT of the template below. This page is prerendered
// (scripts/prerender.mjs) and the production client build strips template
// comments, so a comment in the template renders server-side, vanishes on the
// client, and every page logs a hydration mismatch. Document things here.
const APP_STORE_URL =
  "https://apps.apple.com/us/app/bara-step-challenges/id6760504694";

// Why the capybara's `bottom` offsets are the odd numbers they are: the walk
// sprite has 14px of TRANSPARENT padding below the feet inside its 64px cell,
// so aligning the element's box to the grass leaves the animal hovering. The
// offsets put the FEET on the grass instead:
//   grass surface  = 3px below the top of the 82px strip -> 79px above its base
//   sprite padding = 14px at 64px wide (mobile), 17.5px at 80px (sm and up)
//   bottom         = 79 - padding  ->  65 mobile, 61 sm  (65 rounded to 64 so
//                    the feet sink a pixel into the grass rather than skim it)
// Re-measure both if either asset is ever replaced.

// The six powerups, with the app's real art. `effect` is the backend's own
// catalog copy (src/modules/powerups/constants/powerupCopySeed.js), lightly
// trimmed for a marketing page — so the site can't promise a duration the game
// doesn't actually apply.
const powerups = [
  { art: runnersHigh, name: "Runner's High", effect: "2x your steps for an hour." },
  { art: wrongTurn, name: "Wrong Turn", effect: "Reverse a rival's steps for an hour." },
  { art: proteinShake, name: "Protein Shake", effect: "+1,500 bonus steps, instantly." },
  { art: stealthMode, name: "Stealth Mode", effect: "Hide your name, steps, and position for an hour." },
  { art: trailMine, name: "Trail Mine", effect: "Buries a trap at your step count. It goes off on the first rival to cross it." },
  { art: rainstorm, name: "Rainstorm", effect: "Everyone else's steps count for half for an hour." },
];
</script>

<template>
  <SiteHeader current="home" />

  <main class="paper">
    <section class="relative overflow-hidden">
      <div class="mx-auto max-w-6xl px-5 pt-12 pb-6 sm:px-8 sm:pt-20">
        <p class="eyebrow mb-5 text-paper-accent">Free on iPhone</p>

        <h1
          class="max-w-4xl font-wordmark text-[clamp(2.6rem,8vw,5.5rem)] leading-[0.98] tracking-[0.01em] text-paper-foreground"
        >
          Step challenges are more fun when you can steal steps from someone.
        </h1>

        <p
          class="mt-7 max-w-2xl font-body text-lg leading-relaxed text-paper-muted sm:text-xl"
        >
          Bara turns your daily step count into a live race against your friends.
          Earn mystery boxes as you walk, unleash power-ups, steal steps, freeze
          your competition, and do whatever it takes to cross the finish line
          first.
        </p>

        <div class="mt-9 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center">
          <a
            :href="APP_STORE_URL"
            class="inline-block rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
          >
            <img
              :src="appStoreBadge"
              alt="Download on the App Store"
              width="144"
              height="48"
              class="h-12 w-auto"
            />
          </a>
          <Button as="a" href="#android" variant="paper" size="lg" class="self-start">
            Android — join the waitlist
          </Button>
        </div>
      </div>

      <div class="mt-10 sm:mt-14">
        <div class="relative">
          <div class="capy-runner z-10 bottom-[64px] sm:bottom-[61px]" aria-hidden="true">
            <div
              class="capy-walk"
              :style="{ '--capy-sprite': `url(${capySprite})` }"
            />
          </div>

          <div
            class="trail-ground"
            :style="{ '--trail-ground': `url(${trailGround})` }"
            aria-hidden="true"
          />
        </div>
      </div>
    </section>

    <ReviewsMarquee />

    <section class="border-t border-paper-border">
      <div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <p class="eyebrow mb-4 text-paper-ember">What's in the boxes</p>
        <h2
          class="mb-4 max-w-3xl font-wordmark text-[clamp(2.1rem,5vw,3.6rem)] leading-[1.02] tracking-[0.01em] text-paper-foreground"
        >
          Dozens of ways to shake up the race.
        </h2>
        <p class="mb-10 max-w-xl font-body text-lg text-paper-muted sm:mb-14">
          Mystery boxes drop as you walk. Some of what's inside speeds you up.
          The rest slows your friends down.
        </p>

        <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <li
            v-for="p in powerups"
            :key="p.name"
            class="flex items-start gap-4 rounded-lg border border-paper-border bg-paper-raised p-5"
          >
            <img
              :src="p.art"
              alt=""
              width="56"
              height="56"
              loading="lazy"
              class="pixel size-14 shrink-0"
            />
            <div>
              <p class="font-display text-lg font-bold text-paper-foreground">
                {{ p.name }}
              </p>
              <p class="mt-1 font-body text-sm leading-relaxed text-paper-muted">
                {{ p.effect }}
              </p>
            </div>
          </li>
        </ul>
      </div>
    </section>

    <section
      id="android"
      class="scroll-mt-8 border-t border-paper-border bg-paper-raised"
    >
      <div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <div class="max-w-2xl">
          <div class="mb-6 flex items-center gap-3">
            <GooglePlayMark />
            <p class="eyebrow text-paper-accent">Android</p>
          </div>

          <h2
            class="mb-4 font-wordmark text-[clamp(2.1rem,5vw,3.6rem)] leading-[1.02] tracking-[0.01em] text-paper-foreground"
          >
            Not on Android yet.
          </h2>
          <p class="mb-8 font-body text-lg leading-relaxed text-paper-muted">
            Bara is on iPhone today. Leave your email and we'll tell you the day
            the Android app is ready — nothing else, ever.
          </p>

          <WaitlistForm />
        </div>
      </div>
    </section>
  </main>

  <SiteFooter />
</template>
