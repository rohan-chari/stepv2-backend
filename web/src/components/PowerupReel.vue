<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import runnersHigh from "@/assets/runners_high.png";
import wrongTurn from "@/assets/wrong_turn.png";
import proteinShake from "@/assets/protein_shake.png";
import stealthMode from "@/assets/stealth_mode.png";
import trailMine from "@/assets/trail_mine.png";
import rainstorm from "@/assets/rainstorm.png";

// The mystery-box reel, ported from the app's case-opening cabinet (the Flutter
// repo's lib/widgets/case_opening_strip.dart). Chrome and colours live in
// main.css under ".reel-*"; this file owns the contents and the interaction.
//
// ── Why native scrolling, not an animated spin ───────────────────────────────
// The app's reel is a one-shot: you swipe, it flies, it lands on the powerup the
// server rolled. A marketing page has the opposite job — the visitor must be
// able to reach ALL SIX and read what each one does. So the swipe here drives a
// real scroller with scroll-snap instead of a scripted animation. Everything the
// reel is recognisable BY survives: the felt window, the gold frame, the chevron
// pointer and win line, the edge fades, the rarity-bordered tiles, and the
// lock-in pop on whatever lands under the pointer.
//
// This also means the reel WORKS with JavaScript off, which matters because
// these pages are prerendered (scripts/prerender.mjs). Scroll-snap, the tiles
// and the caption are all in the served HTML; the script below only adds
// mouse click-and-drag and keeps the caption in step with the scroll position.
//
// ── Accessibility ────────────────────────────────────────────────────────────
// The reel is not a decorative belt like the review marquee — it carries the
// section's whole content — so it is exposed rather than aria-hidden: the track
// is a focusable scroll region, and each tile of the FIRST copy is a button
// labelled "Name. Effect." The caption below repeats the label of whatever has
// snapped, so it IS aria-hidden; announcing it too would say everything twice.
//
// NOTE: keep HTML comments OUT of the template. The production client build
// strips template comments, so a comment there renders server-side, vanishes on
// the client, and logs a hydration mismatch. Document things up here.

// Rarity is a COLOUR ONLY, never a word — the same rule the app follows on every
// reel and powerup surface. Values are the app's caseRarityColor().
const RARITY_COLOR = {
  COMMON: "#4F8A6A",
  UNCOMMON: "#4A90D9",
  RARE: "#B8860B",
};

// `effect` is the backend's own catalog copy (powerupCopySeed.js), lightly
// trimmed for a marketing page — so the site can't promise a duration the game
// doesn't actually apply. `rarity` is the backend's canonical rarityByType
// (src/modules/economy/balanceConfig.defaults.js); keep them in step, or a tile
// advertises a rarity the drop table disagrees with.
const powerups = [
  {
    art: proteinShake,
    name: "Protein Shake",
    rarity: "COMMON",
    effect: "+1,500 bonus steps, instantly.",
  },
  {
    art: runnersHigh,
    name: "Runner's High",
    rarity: "COMMON",
    effect: "2x your steps for an hour.",
  },
  {
    art: wrongTurn,
    name: "Wrong Turn",
    rarity: "UNCOMMON",
    effect: "Reverse a rival's steps for an hour.",
  },
  {
    art: stealthMode,
    name: "Stealth Mode",
    rarity: "UNCOMMON",
    effect: "Hide your name, steps, and position for an hour.",
  },
  {
    art: trailMine,
    name: "Trail Mine",
    rarity: "RARE",
    effect:
      "Buries a trap at your step count. It goes off on the first rival to cross it.",
  },
  {
    art: rainstorm,
    name: "Rainstorm",
    rarity: "RARE",
    effect: "Everyone else's steps count for half for an hour.",
  },
];

// The app's reel is 45 tiles deep, so it is packed edge to edge whichever way
// you push it. Six cards would leave the window half empty at either end, which
// is exactly what would give the port away — so the set is laid down three times
// over. The caption reads through `% powerups.length`, so which copy you happen
// to be looking at never matters.
//
// Only the FIRST copy is exposed to assistive tech and to the keyboard; copies
// two and three are aria-hidden and tabindex="-1". Otherwise a screen reader
// would read all six powerups three times over, and tabbing through the section
// would take eighteen stops to leave it.
const REPEATS = 3;
const strip = computed(() =>
  Array.from({ length: REPEATS }, (_, copy) =>
    powerups.map((p) => ({ ...p, key: `${copy}-${p.name}`, decorative: copy > 0 }))
  ).flat()
);

const track = ref(null);

// Written by an index-keyed function ref rather than `ref="tiles"`: Vue does not
// guarantee that a v-for ref array matches source order, and syncActive() reads
// this array BY INDEX to decide which powerup is under the pointer. Assigning by
// index makes that alignment a fact instead of an assumption.
const tiles = [];

// 0 on BOTH the prerender and the first client render — anything derived from a
// live scroll position here would be a hydration mismatch.
//
// `live` is what makes that safe rather than merely quiet. The track opens at
// scrollLeft 0 and is not padded by half a window, so the tile under the pointer
// at rest is NEVER tile 0 — it is whichever one the viewport width happens to
// centre (tile 2 on a wide screen, tile 1 on a phone). A caption rendered from
// `active` before the first syncActive() is therefore wrong, and on the
// prerendered no-JS page it would stay wrong forever: the pointer sits on Wrong
// Turn while the page announces Protein Shake in 20px type.
//
// So until `live` flips in onMounted, the caption does not exist — a plain list
// of all six stands in its place (see the template), which is also the only way
// a no-JS visitor gets the other five effects at all. It flips inside the same
// task as hydration, so the swap lands before first paint.
const active = ref(0);
const live = ref(false);
const dragging = ref(false);
const current = computed(() => powerups[active.value % powerups.length]);

let frame = 0;
let cleanup = () => {};

function colorFor(rarity) {
  return RARITY_COLOR[rarity] ?? RARITY_COLOR.COMMON;
}

// Whichever tile centre sits closest to the window centre is "under the
// pointer" — the same thing the app's reel decides by where it stopped.
function syncActive() {
  const el = track.value;
  if (!el) return;
  const middle = el.scrollLeft + el.clientWidth / 2;
  let best = 0;
  let bestDistance = Infinity;
  tiles.forEach((tile, index) => {
    if (!tile) return;
    const distance = Math.abs(tile.offsetLeft + tile.offsetWidth / 2 - middle);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  active.value = best;
}

function onScroll() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    syncActive();
  });
}

function reveal(index) {
  const el = track.value;
  const tile = tiles[index];
  if (!el || !tile) return;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({
    left: tile.offsetLeft + tile.offsetWidth / 2 - el.clientWidth / 2,
    behavior: reduced ? "auto" : "smooth",
  });
}

onMounted(() => {
  const el = track.value;
  if (!el) return;

  // Drag-to-scroll for mice. Touch and trackpads already swipe the scroller
  // natively, so they are deliberately left alone — hijacking them costs the
  // native fling and the snap that comes with it.
  let startX = 0;
  let startScroll = 0;
  let moved = 0;
  // Set when a drag ends far enough to have been a drag rather than a tap, and
  // cleared by the click it suppresses. Kept separate from `moved` because
  // `moved` is only ever reset on a MOUSE pointerdown: on a hybrid device (a
  // touchscreen laptop, an iPad with a mouse) a leftover `moved` would swallow
  // the next finger tap, which never runs onPointerDown at all.
  let suppressClick = false;

  const onPointerDown = (event) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    dragging.value = true;
    moved = 0;
    startX = event.clientX;
    startScroll = el.scrollLeft;
    el.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event) => {
    if (!dragging.value) return;
    const dx = event.clientX - startX;
    moved = Math.max(moved, Math.abs(dx));
    el.scrollLeft = startScroll - dx;
  };

  const endDrag = (event) => {
    if (!dragging.value) return;
    dragging.value = false;
    suppressClick = moved > 6;
    moved = 0;
    if (el.hasPointerCapture?.(event.pointerId)) {
      el.releasePointerCapture(event.pointerId);
    }
    // Re-arming scroll-snap does not itself re-snap, so nudge the nearest tile
    // back under the pointer — otherwise a drag can rest between two cards.
    syncActive();
    reveal(active.value);
  };

  // A drag that crossed the felt must not also count as a click on the tile it
  // ended over, which would immediately scroll somewhere else.
  const onClickCapture = (event) => {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  };

  el.addEventListener("scroll", onScroll, { passive: true });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("click", onClickCapture, true);

  // A resize or a rotate changes clientWidth, and therefore which tile is
  // centred, without necessarily firing a scroll event — the caption and the
  // lock-in pop would keep pointing at the old one until the visitor scrolled.
  const observer = new ResizeObserver(() => syncActive());
  observer.observe(el);

  syncActive();
  live.value = true;

  cleanup = () => {
    observer.disconnect();
    el.removeEventListener("scroll", onScroll);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", endDrag);
    el.removeEventListener("pointercancel", endDrag);
    el.removeEventListener("click", onClickCapture, true);
  };
});

onBeforeUnmount(() => {
  if (frame) cancelAnimationFrame(frame);
  cleanup();
});
</script>

<template>
  <div class="max-w-3xl">
    <div class="reel-cabinet">
      <p class="eyebrow mb-2.5 text-center" style="color: #66796f">
        Swipe the reel
      </p>

      <div class="reel-window">
        <div
          ref="track"
          class="reel-track"
          :class="{ 'is-live': live, 'is-dragging': dragging }"
          tabindex="0"
          role="group"
          aria-label="Power-ups"
        >
          <button
            v-for="(p, index) in strip"
            :key="p.key"
            :ref="(el) => (tiles[index] = el)"
            type="button"
            class="reel-tile"
            :style="{ '--rarity': colorFor(p.rarity) }"
            :aria-current="index === active ? 'true' : undefined"
            :aria-hidden="p.decorative ? 'true' : undefined"
            :tabindex="p.decorative ? -1 : undefined"
            :aria-label="`${p.name}. ${p.effect}`"
            @click="reveal(index)"
          >
            <img
              :src="p.art"
              alt=""
              draggable="false"
              width="64"
              height="64"
              loading="lazy"
              class="pixel size-16"
            />
            <span class="reel-tile-name">{{ p.name }}</span>
          </button>
        </div>

        <div class="reel-line"></div>
        <div class="reel-fade reel-fade-left"></div>
        <div class="reel-fade reel-fade-right"></div>

        <svg
          class="reel-pointer reel-pointer-top"
          aria-hidden="true"
          width="28"
          height="16"
          viewBox="0 0 28 16"
        >
          <path d="M0 0H28L14 16Z" fill="#ECC86A" stroke="#9A7A2D" stroke-width="2" />
        </svg>
        <svg
          class="reel-pointer reel-pointer-bottom"
          aria-hidden="true"
          width="28"
          height="16"
          viewBox="0 0 28 16"
        >
          <path d="M0 0H28L14 16Z" fill="#ECC86A" stroke="#9A7A2D" stroke-width="2" />
        </svg>
      </div>

      <p class="mt-3.5 text-center font-body text-sm font-bold" style="color: #66796f">
        drag across the reel
      </p>
    </div>

    <div v-if="live" class="mt-7 text-center" aria-hidden="true">
      <p class="font-display text-xl font-bold text-paper-foreground">
        {{ current.name }}
      </p>
      <span
        class="mx-auto mt-2.5 block h-[3px] w-11 rounded-sm"
        :style="{ backgroundColor: colorFor(current.rarity) }"
      ></span>
      <p class="mx-auto mt-3 max-w-sm font-body text-base leading-relaxed text-paper-muted">
        {{ current.effect }}
      </p>
    </div>

    <ul v-else class="mt-7 grid gap-3 sm:grid-cols-2">
      <li v-for="p in powerups" :key="`still-${p.name}`" class="flex items-baseline gap-2">
        <span
          class="mt-1.5 size-2 shrink-0 self-start rounded-full"
          :style="{ backgroundColor: colorFor(p.rarity) }"
        ></span>
        <span class="font-body text-sm leading-relaxed text-paper-muted">
          <span class="font-display font-bold text-paper-foreground">{{ p.name }}</span>
          — {{ p.effect }}
        </span>
      </li>
    </ul>
  </div>
</template>
