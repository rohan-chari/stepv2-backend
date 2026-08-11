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
// main.css under ".reel-*"; this file owns the contents and the motion.
//
// ── Why this drives a transform instead of a scroll container ────────────────
// The first cut used native overflow scrolling with scroll-snap. It could not be
// made to do the three things this reel is FOR: a flick has no deceleration
// curve (the browser's fling is not ours to shape), it cannot loop (a scroller
// has ends, so a hard swipe just stops dead against one), and it cannot drift on
// its own. The app has exactly none of those problems because it never scrolls —
// CaseOpeningReel translates a Row under an AnimationController. So does this.
//
// `pos` is an unbounded virtual offset in px, rising as the reel advances left.
// The strip is COPIES copies of the six, and the row is translated by
// `pos mod copyWidth` plus one copy's slack, so there is always a copy of
// content off both edges. Crossing a copy boundary shifts the transform by
// exactly one copy width — identical pixels, so the wrap is invisible and the
// reel is genuinely endless in both directions.
//
// ── Accessibility ────────────────────────────────────────────────────────────
// This is now an autoplaying animation with no stable stopping point, so the
// cabinet is aria-hidden and contains NOTHING focusable — tiles are divs, not
// buttons. The six names and effects live in the list below it, which is the
// real content: visible when JavaScript is off (where it is also the only way to
// read the five powerups not under the pointer), sr-only when the live caption
// takes over.
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

// Must match main.css: --tile-width and the track's gap.
const TILE_W = 128;
const GAP = 8;
const STEP = TILE_W + GAP;
const COPY_W = powerups.length * STEP;

// Enough copies that one copy of content always hangs off BOTH edges, for any
// window this cabinet can reach. The transform never exceeds 2 copies of slack,
// so COPIES * COPY_W must clear (widest window + 2 copies): at 5 copies that
// holds out to a ~2400px window, well past the max-w-6xl column it lives in.
const COPIES = 5;
const strip = computed(() =>
  Array.from({ length: COPIES }, (_, copy) =>
    powerups.map((p, index) => ({ ...p, key: `${copy}-${p.name}`, index }))
  ).flat()
);

// Idle drift: settle on a powerup, hold long enough to read it, glide to the
// next. A continuous crawl was the other option and is worse — the caption
// would never sit still and the pointer would never mean anything.
const AUTO_HOLD_MS = 1900;
const AUTO_GLIDE_MS = 620;
// How long after you let go before the reel starts drifting again.
const RESUME_AFTER_MS = 2600;
// Per-frame velocity decay at 60fps, and the speed below which a spin is over.
// A flick coasts roughly v0 * 0.42 px, so a hard one crosses many tiles before
// the snap takes over — the reel should feel thrown, not nudged.
const FRICTION = 0.96;
const STOP_BELOW = 30;

const window_ = ref(null);
const live = ref(false);
const pos = ref(0);
const litIndex = ref(-1);
const activePowerup = ref(0);
const current = computed(() => powerups[activePowerup.value]);

// SSR and the first client render both produce this exact transform: pos 0 with
// one copy of slack. No measurement, so no hydration mismatch.
const shift = computed(() => {
  const wrapped = ((pos.value % COPY_W) + COPY_W) % COPY_W;
  return wrapped + COPY_W;
});

function colorFor(rarity) {
  return RARITY_COLOR[rarity] ?? RARITY_COLOR.COMMON;
}

let raf = 0;
let autoTimer = 0;
let resumeTimer = 0;
let cleanup = () => {};

onMounted(() => {
  const el = window_.value;
  if (!el) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  let viewport = el.clientWidth;
  let velocity = 0;
  let dragging = false;
  let pointerId = null;
  let lastX = 0;
  let lastT = 0;
  let dragged = 0;
  let hovering = false;
  let onScreen = true;
  let tween = null;
  let lastFrame = 0;

  // Aligned once, on the first real measurement: park a tile squarely under the
  // pointer AND make it the first powerup, so the reel always opens on Protein
  // Shake instead of on whatever the viewport width happened to centre. Runs
  // before the first client paint, so the correction is never seen.
  let aligned = false;

  const measure = () => {
    viewport = el.clientWidth;
    if (!aligned && viewport > 0) {
      aligned = true;
      pos.value += snapDelta();
      const i = Math.round((shift.value + viewport / 2 - TILE_W / 2) / STEP);
      pos.value +=
        (((powerups.length - (i % powerups.length)) % powerups.length) * STEP);
    }
    paint();
  };

  // Which tile sits under the gold pointer. Works in ROW coordinates, so it
  // survives the wrap: after a boundary crossing this lands on a different DOM
  // node showing the same powerup at the same place on screen.
  function paint() {
    const centre = shift.value + viewport / 2;
    const i = Math.round((centre - TILE_W / 2) / STEP);
    litIndex.value = Math.max(0, Math.min(strip.value.length - 1, i));
    activePowerup.value = ((i % powerups.length) + powerups.length) % powerups.length;
  }

  // Distance to the nearest tile boundary — what turns a spin's dying momentum
  // into a card locked under the pointer rather than one parked halfway.
  function snapDelta() {
    const x = (shift.value + viewport / 2 - TILE_W / 2) / STEP;
    return (Math.round(x) - x) * STEP;
  }

  function startLoop() {
    if (raf) return;
    lastFrame = performance.now();
    raf = requestAnimationFrame(step);
  }

  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function glideTo(distance, ms) {
    const from = pos.value;
    const start = performance.now();
    tween = (now) => {
      const t = Math.min(1, (now - start) / ms);
      // easeOutQuart — the app's own reel curve.
      const eased = 1 - Math.pow(1 - t, 4);
      pos.value = from + distance * eased;
      if (t >= 1) {
        tween = null;
        return true;
      }
      return false;
    };
    startLoop();
  }

  function step(now) {
    raf = 0;
    const dt = Math.min(64, now - lastFrame) / 16.6667;
    lastFrame = now;

    let busy = false;

    if (tween) {
      const done = tween(now);
      busy = !done;
      if (done) scheduleAuto();
    } else if (Math.abs(velocity) > 0) {
      pos.value += velocity * (dt / 60);
      velocity *= Math.pow(FRICTION, dt);
      if (Math.abs(velocity) < STOP_BELOW) {
        velocity = 0;
        glideTo(snapDelta(), 260);
        busy = true;
      } else {
        busy = true;
      }
    }

    paint();
    if (busy || dragging) startLoop();
  }

  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (reduced.matches || hovering || dragging || !onScreen) return;
    autoTimer = setTimeout(() => {
      if (reduced.matches || hovering || dragging || !onScreen) return;
      glideTo(STEP + snapDelta(), AUTO_GLIDE_MS);
    }, AUTO_HOLD_MS);
  }

  function pauseAuto() {
    clearTimeout(autoTimer);
    clearTimeout(resumeTimer);
  }

  function resumeAutoSoon() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(scheduleAuto, RESUME_AFTER_MS);
  }

  const onPointerDown = (event) => {
    if (event.button != null && event.button !== 0) return;
    dragging = true;
    dragged = 0;
    velocity = 0;
    tween = null;
    pauseAuto();
    pointerId = event.pointerId;
    lastX = event.clientX;
    lastT = performance.now();
    el.setPointerCapture?.(pointerId);
    startLoop();
  };

  const onPointerMove = (event) => {
    if (!dragging) return;
    const now = performance.now();
    const dx = event.clientX - lastX;
    const dt = Math.max(1, now - lastT);
    dragged += Math.abs(dx);
    // Dragging right pulls the reel right, so the virtual offset goes down.
    pos.value -= dx;
    // Weighted toward the most recent sample so the throw matches the gesture,
    // but not raw — one jittery frame at release must not decide the spin.
    velocity = velocity * 0.4 + ((-dx / dt) * 1000) * 0.6;
    lastX = event.clientX;
    lastT = now;
    paint();
  };

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      if (el.hasPointerCapture?.(pointerId)) el.releasePointerCapture(pointerId);
      pointerId = null;
    }
    if (reduced.matches || Math.abs(velocity) < STOP_BELOW) {
      velocity = 0;
      glideTo(snapDelta(), 220);
    } else {
      startLoop();
    }
    resumeAutoSoon();
  };

  // A flick that travelled must not also count as a click on the tile it ended
  // over — that would yank the reel somewhere the user never asked for.
  const onClick = (event) => {
    if (dragged > 6) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const tile = event.target.closest?.(".reel-tile");
    if (!tile) return;
    const i = Number(tile.dataset.i);
    if (Number.isNaN(i)) return;
    pauseAuto();
    const centreOf = i * STEP + TILE_W / 2;
    glideTo(centreOf - (shift.value + viewport / 2), 420);
    resumeAutoSoon();
  };

  // Desktop "swipe" is a two-finger trackpad gesture, which arrives as wheel
  // events, NOT as a drag. The scroll-snap version got this free by being a real
  // scroller; a transformed row gets nothing unless it asks. Without this the
  // reel is dead to every trackpad on the site, which is most desktop visitors.
  //
  // Only HORIZONTAL gestures are claimed. A vertical wheel must keep scrolling
  // the page — swallowing it would trap the reader inside the cabinet. Claiming
  // the horizontal one also suppresses macOS swipe-to-go-back, which would
  // otherwise navigate away mid-gesture.
  let wheelTimer = 0;
  const onWheel = (event) => {
    if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
    event.preventDefault();
    // deltaMode 1 is lines, not pixels — some mice report that way.
    const dx = event.deltaX * (event.deltaMode === 1 ? 16 : 1);
    pauseAuto();
    tween = null;
    velocity = 0;
    pos.value += dx;
    paint();
    // The trackpad's own momentum tail supplies the spin, so all that is left is
    // to land square once the tail stops arriving.
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      glideTo(snapDelta(), 220);
      resumeAutoSoon();
    }, 130);
  };

  const onEnter = () => {
    hovering = true;
    pauseAuto();
  };
  const onLeave = () => {
    hovering = false;
    resumeAutoSoon();
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("click", onClick, true);
  el.addEventListener("wheel", onWheel, { passive: false });
  el.addEventListener("pointerenter", onEnter);
  el.addEventListener("pointerleave", onLeave);

  const resize = new ResizeObserver(measure);
  resize.observe(el);

  // Don't animate a cabinet nobody is looking at.
  const seen = new IntersectionObserver(
    (entries) => {
      onScreen = entries[0]?.isIntersecting ?? true;
      if (onScreen) scheduleAuto();
      else pauseAuto();
    },
    { threshold: 0.1 }
  );
  seen.observe(el);

  const onMotionPref = () => (reduced.matches ? pauseAuto() : scheduleAuto());
  reduced.addEventListener?.("change", onMotionPref);

  // A hidden tab freezes rAF but not setTimeout, so without this the drift timer
  // keeps firing against a tween that cannot advance — and the reel jumps a tile
  // the moment you come back to it.
  const onVisibility = () =>
    document.hidden ? pauseAuto() : (tween = null, scheduleAuto());
  document.addEventListener("visibilitychange", onVisibility);

  measure();
  live.value = true;
  scheduleAuto();

  cleanup = () => {
    stopLoop();
    pauseAuto();
    resize.disconnect();
    seen.disconnect();
    reduced.removeEventListener?.("change", onMotionPref);
    document.removeEventListener("visibilitychange", onVisibility);
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointermove", onPointerMove);
    el.removeEventListener("pointerup", endDrag);
    el.removeEventListener("pointercancel", endDrag);
    el.removeEventListener("click", onClick, true);
    clearTimeout(wheelTimer);
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("pointerenter", onEnter);
    el.removeEventListener("pointerleave", onLeave);
  };
});

onBeforeUnmount(() => cleanup());
</script>

<template>
  <div>
    <div class="reel-cabinet" aria-hidden="true">
      <p class="eyebrow reel-label mb-2.5 text-center">Swipe the reel</p>

      <div ref="window_" class="reel-window">
        <div
          class="reel-track"
          :class="{ 'is-live': live }"
          :style="{ transform: `translate3d(${-shift}px, 0, 0)` }"
        >
          <div
            v-for="(p, i) in strip"
            :key="p.key"
            :data-i="i"
            class="reel-tile"
            :class="{ 'is-lit': i === litIndex }"
            :style="{ '--rarity': colorFor(p.rarity) }"
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
          </div>
        </div>

        <div class="reel-line"></div>
        <div class="reel-fade reel-fade-left"></div>
        <div class="reel-fade reel-fade-right"></div>

        <svg class="reel-pointer reel-pointer-top" width="28" height="16" viewBox="0 0 28 16">
          <path d="M0 0H28L14 16Z" fill="#ECC86A" stroke="#9A7A2D" stroke-width="2" />
        </svg>
        <svg class="reel-pointer reel-pointer-bottom" width="28" height="16" viewBox="0 0 28 16">
          <path d="M0 0H28L14 16Z" fill="#ECC86A" stroke="#9A7A2D" stroke-width="2" />
        </svg>
      </div>

      <p class="reel-hint mt-3.5 text-center font-body text-sm font-bold">
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

    <ul :class="live ? 'sr-only' : 'mt-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-3'">
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
