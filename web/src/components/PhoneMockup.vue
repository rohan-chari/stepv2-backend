<script setup>
import capySprite from "@/assets/capybara_walk_right.png";
import leech from "@/assets/leech.png";

// A phone showing a race in progress, with the moment the page is actually
// selling: a Leech landing on a rival and taking a slice of their steps.
//
// ── This is a composed mockup, not a screen capture ─────────────────────────
// The powerup icon and the walk sprite are the app's REAL shipped art. The
// frame and the rows are HTML — CLAUDE.md allows hand-coded UI chrome (cards,
// shadows, type, layout) and forbids hand-drawn artwork, and nothing here is
// artwork.
//
// A genuine screenshot needs a signed-in account inside a live race, and every
// such capture we have carries real usernames. The names below are invented on
// purpose and MUST stay invented. If a real screenshot replaces this, it drops
// into the same slot as a single <img> and everything else here can go.
//
// No HTML comments in the template — these pages are prerendered and the
// production client build strips template comments, desyncing hydration.
const standings = [
  { place: "1", name: "You", steps: "12,480", you: true },
  { place: "2", name: "Marcus", steps: "11,240", you: false },
  { place: "3", name: "Priya", steps: "9,905", you: false },
];
</script>

<template>
  <div
    class="relative mx-auto w-full max-w-[19rem] rounded-[2.5rem] border-[3px] border-canopy-deep bg-canopy-deep p-2.5 shadow-[0_28px_60px_var(--bara-shadow)]"
    role="img"
    aria-label="A Bara race in progress: you are first with 12,480 steps, and a Leech powerup has just taken 1,240 steps from Marcus."
  >
    <div
      class="absolute top-2.5 left-1/2 z-10 h-6 w-24 -translate-x-1/2 rounded-b-2xl bg-canopy-deep"
      aria-hidden="true"
    />

    <div class="overflow-hidden rounded-[2rem] bg-paper" aria-hidden="true">
      <div class="bg-background px-4 pt-8 pb-4">
        <p class="eyebrow text-primary">Weekend Warriors</p>
        <p class="mt-1 font-display text-lg font-extrabold text-foreground">
          2 days left
        </p>
      </div>

      <div class="relative border-b border-paper-border bg-paper-raised px-4 py-5">
        <div
          class="h-[3px] w-full bg-[repeating-linear-gradient(to_right,var(--paper-border)_0_10px,transparent_10px_18px)]"
        />
        <div
          class="absolute bottom-[14px] left-[58%] size-10 bg-[length:240px_40px] bg-no-repeat [image-rendering:pixelated]"
          :style="{ backgroundImage: `url(${capySprite})` }"
        />
      </div>

      <div class="divide-y divide-paper-border">
        <div
          v-for="row in standings"
          :key="row.name"
          class="flex items-center gap-3 px-4 py-3"
          :class="row.you ? 'bg-[color-mix(in_srgb,var(--primary)_16%,transparent)]' : ''"
        >
          <span class="w-4 font-mono text-xs text-paper-muted">{{ row.place }}</span>
          <span
            class="flex-1 font-display text-sm font-bold text-paper-foreground"
            :class="row.you ? 'text-paper-accent' : ''"
            >{{ row.name }}</span
          >
          <span class="font-mono text-sm text-paper-foreground">{{ row.steps }}</span>
        </div>
      </div>

      <div class="m-3 flex items-center gap-3 rounded-lg bg-canopy-deep p-3">
        <img
          :src="leech"
          alt=""
          width="36"
          height="36"
          class="pixel size-9 shrink-0"
        />
        <div>
          <p class="font-display text-sm font-bold text-foreground">Leech landed</p>
          <p class="mt-0.5 font-body text-xs leading-snug text-muted-foreground">
            You stole 1,240 steps from Marcus.
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
