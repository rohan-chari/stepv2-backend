<script setup>
import SiteHeader from "@/components/SiteHeader.vue";
import SiteFooter from "@/components/SiteFooter.vue";
import WaitlistForm from "@/components/WaitlistForm.vue";
import { Button } from "@/components/ui/button";
import capySprite from "@/assets/capybara_walk_right.png";
import coin from "@/assets/coin.png";
import trailMine from "@/assets/trail_mine.png";
import leech from "@/assets/leech.png";
import rainstorm from "@/assets/rainstorm.png";
import shortcut from "@/assets/shortcut.png";
import signalJammer from "@/assets/signal_jammer.png";
import luckyHorseshoe from "@/assets/lucky_horseshoe.png";

// Page order: hero (the thesis — your steps are a race) -> the trail, where the
// game's real walk sprite walks it -> how it works -> the powerups -> the
// Android waitlist.
//
// NOTE: keep HTML comments OUT of the template below. This page is prerendered
// (scripts/prerender.mjs) and the production client build strips template
// comments, so a comment in the template renders server-side, vanishes on the
// client, and every page logs a hydration mismatch. Document things here.
const APP_STORE_URL =
  "https://apps.apple.com/us/app/bara-step-challenges/id6760504694";

// The real powerups, with the real art. Copy is what each one does to another
// player, in their words, not the mechanic's name.
const powerups = [
  { art: trailMine, name: "Trail Mine", effect: "Buried on the course. Whoever hits it loses ground." },
  { art: leech, name: "Leech", effect: "Siphons a cut of a rival's steps to you." },
  { art: rainstorm, name: "Rainstorm", effect: "Slows everyone caught in it for an hour." },
  { art: signalJammer, name: "Signal Jammer", effect: "Hides the leaderboard from whoever's chasing you." },
  { art: shortcut, name: "Shortcut", effect: "Skip ahead while nobody's looking." },
  { art: luckyHorseshoe, name: "Lucky Horseshoe", effect: "Better odds on whatever you open next." },
];

// The three things the app actually does, in the order you meet them.
const howItWorks = [
  {
    label: "Your steps",
    body: "Bara reads your daily step count from Apple Health or Health Connect. That number is your position on the course.",
  },
  {
    label: "The race",
    body: "Start a race with friends over a day, a week, or a fortnight. Everyone's steps move them down the same trail, live.",
  },
  {
    label: "The mischief",
    body: "Mystery boxes drop as you walk. Inside: powerups to speed yourself up — or to slow your friends down and hear about it later.",
  },
];
</script>

<template>
  <SiteHeader current="home" />

  <main class="paper">
    <section class="relative overflow-hidden">
      <div class="mx-auto max-w-6xl px-5 pt-12 pb-6 sm:px-8 sm:pt-24">
        <p class="eyebrow mb-5 text-paper-accent">Step challenges with friends</p>

        <h1
          class="max-w-4xl font-display text-[clamp(2.75rem,9vw,6.5rem)] leading-[0.92] font-extrabold tracking-[-0.035em] text-paper-foreground"
        >
          <span class="block">Your steps are</span>
          <span class="block text-paper-accent">a race.</span>
        </h1>

        <p
          class="mt-7 max-w-xl font-body text-lg leading-relaxed text-paper-muted sm:text-xl"
        >
          Bara turns your daily step count into a live race against your
          friends — with mystery boxes, powerups, and every trick they can throw
          at you.
        </p>

        <div class="mt-9 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <Button as="a" :href="APP_STORE_URL" size="lg" class="w-full sm:w-auto">
            Download on iPhone
          </Button>
          <Button
            as="a"
            href="#android"
            variant="paper"
            size="lg"
            class="w-full sm:w-auto"
          >
            Android — join the waitlist
          </Button>
        </div>
      </div>

      <div class="mx-auto max-w-6xl px-5 pt-8 pb-14 sm:px-8 sm:pb-20">
        <div class="relative">
          <div class="capy-runner bottom-[7px] z-10 sm:bottom-[9px]" aria-hidden="true">
            <div
              class="capy-walk"
              :style="{ '--capy-sprite': `url(${capySprite})` }"
            />
          </div>

          <div
            class="h-[3px] w-full bg-[repeating-linear-gradient(to_right,var(--paper-border)_0_14px,transparent_14px_26px)]"
            aria-hidden="true"
          />

          <div class="mt-3 flex justify-between">
            <span
              v-for="tick in ['0', '4k', '8k', '12k', '16k']"
              :key="tick"
              class="font-mono text-xs text-paper-muted"
              aria-hidden="true"
            >
              {{ tick }}
            </span>
          </div>
        </div>
      </div>
    </section>

    <section class="border-t border-paper-border bg-paper-raised">
      <div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <h2
          class="mb-10 max-w-2xl font-display text-[clamp(1.9rem,4vw,3rem)] leading-tight font-extrabold tracking-tight text-paper-foreground sm:mb-14"
        >
          Walk. Compete. Keep them guessing.
        </h2>

        <div class="grid gap-px overflow-hidden rounded-lg bg-paper-border sm:grid-cols-3">
          <div
            v-for="step in howItWorks"
            :key="step.label"
            class="bg-paper-raised p-6 sm:p-7"
          >
            <p class="eyebrow mb-4 text-paper-accent">{{ step.label }}</p>
            <p class="font-body text-base leading-relaxed text-paper-muted">
              {{ step.body }}
            </p>
          </div>
        </div>
      </div>
    </section>

    <section class="border-t border-paper-border">
      <div class="mx-auto max-w-6xl px-5 py-16 sm:px-8 sm:py-20">
        <p class="eyebrow mb-4 text-paper-ember">What's in the boxes</p>
        <h2
          class="mb-4 max-w-2xl font-display text-[clamp(1.9rem,4vw,3rem)] leading-tight font-extrabold tracking-tight text-paper-foreground"
        >
          Dozens of ways to shake up the race.
        </h2>
        <p class="mb-10 max-w-xl font-body text-lg text-paper-muted sm:mb-14">
          Mystery boxes drop as you walk. Some of what's inside gives you a
          boost. The rest is for having fun with your friends.
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
            <img :src="coin" alt="" width="40" height="40" class="pixel size-10" />
            <p class="eyebrow text-paper-accent">Android</p>
          </div>

          <h2
            class="mb-4 font-display text-[clamp(1.9rem,4vw,3rem)] leading-tight font-extrabold tracking-tight text-paper-foreground"
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
