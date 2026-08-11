<script setup>
import { computed, onMounted, ref } from "vue";
import seedReviews from "@/data/reviews.json";

// A continuously scrolling strip of real 5-star App Store reviews.
//
// ── Where the data comes from ────────────────────────────────────────────────
// seedReviews is a build-time snapshot (scripts/fetch-reviews.mjs). Rendering
// from it means the strip is already populated in the prerendered HTML — with
// JavaScript off, and on first paint before any request completes. On mount we
// replace it with the live list from /reviews/ios, which the backend refreshes
// from Apple every 6h.
//
// Starting from the snapshot rather than an empty array is also what keeps
// hydration clean: the server render and the first client render are identical,
// and the swap happens strictly after mount.
//
// ── Safety ───────────────────────────────────────────────────────────────────
// Review text is user-generated content written by strangers. It is rendered
// with {{ }} interpolation only — never v-html — so it cannot inject markup.
// The 5-star filter is applied on the SERVER (appStoreReviews.js); the extra
// client-side filter below is belt-and-braces, not the enforcement point.
//
// No HTML comments in the template — these pages are prerendered and the
// production client build strips template comments, desyncing hydration.
const reviews = ref(seedReviews);

// Enough cards that even a short list fills a wide screen, otherwise the belt
// shows a gap between the end of the list and the start of the duplicate.
const MIN_ITEMS = 8;

// The real reviews, each appearing once. This is what assistive tech reads;
// the belt below pads and repeats it purely for the visual loop.
const fiveStar = computed(() => reviews.value.filter((r) => r.rating === 5));

// ONE loop of the belt. The rendered track is this twice over — see below.
const half = computed(() => {
  if (!fiveStar.value.length) return [];
  const out = [];
  while (out.length < MIN_ITEMS) out.push(...fiveStar.value);
  return out;
});

// The track MUST be exactly two copies of `half`. The animation translates the
// track by -50%, which lands copy two precisely where copy one started — that
// exact correspondence is what makes the loop seamless.
//
// Duplicating explicitly rather than letting a "repeat until long enough" loop
// decide: with 14 reviews that loop pushes once and stops, leaving a SINGLE
// copy, and -50% then scrolls halfway through the only content there is and
// hard-resets. Any odd number of copies breaks it the same way.
const displayed = computed(() => [...half.value, ...half.value]);

// ~9s of travel per card, counted over ONE copy (the visible loop), so the belt
// keeps a constant speed no matter how many reviews the feed returns.
const marqueeSeconds = computed(() => `${half.value.length * 9}s`);

onMounted(async () => {
  try {
    const res = await fetch("/reviews/ios");
    if (!res.ok) return;
    const body = await res.json();
    if (Array.isArray(body.reviews) && body.reviews.length) {
      reviews.value = body.reviews;
    }
  } catch {
    // Keep the snapshot. A stale review beats an empty strip, and this is
    // decoration — it must never surface an error to the visitor.
  }
});
</script>

<template>
  <section v-if="displayed.length" class="border-t border-paper-border py-14 sm:py-16">
    <div class="mx-auto mb-8 max-w-6xl px-5 sm:px-8">
      <h2 class="eyebrow text-paper-accent">From the App Store</h2>
    </div>

    <ul class="sr-only">
      <li v-for="review in fiveStar" :key="review.id">
        Five stars. {{ review.title }}. {{ review.body }} — {{ review.author }}
      </li>
    </ul>

    <div class="marquee-viewport overflow-hidden" aria-hidden="true">
      <div class="marquee" :style="{ '--marquee-seconds': marqueeSeconds }">
        <div
          v-for="(review, index) in displayed"
          :key="`${review.id}-${index}`"
          class="mr-4 flex w-[19rem] shrink-0 flex-col rounded-lg border border-paper-border bg-paper-raised p-5 sm:w-[22rem]"
        >
          <div class="mb-3 flex items-center gap-2">
            <span class="text-sm tracking-[0.15em] text-paper-ember">★★★★★</span>
          </div>
          <p class="font-display text-base font-bold text-paper-foreground">
            {{ review.title }}
          </p>
          <p class="mt-2 flex-1 font-body text-sm leading-relaxed text-paper-muted">
            {{ review.body }}
          </p>
          <p class="mt-4 font-mono text-xs text-paper-muted">{{ review.author }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
