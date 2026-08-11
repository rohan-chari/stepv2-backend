<script setup>
// The app icon + "Bara: Step Challenges", in Jersey 25 — the face the app sets
// its own title screen in (PixelText.display / lib/styles.dart). Header and
// footer both render this, and the three server-rendered share-link pages
// render the byte-for-byte equivalent from theme.wordmarkHtml(); keep the two
// in step.
//
// The icon is the SAME unhashed /icon-192.png express already serves for the
// favicon, not a bundled copy — one logo file, so a new icon lands everywhere
// at once.
//
// ": Step Challenges" is hidden below 420px. The full string in a display face
// does not fit a 320px phone next to the nav. The <a> carries the complete name
// as its aria-label at every width, so what a screen reader announces never
// depends on the viewport.
//
// No HTML comments in the template — these pages are prerendered and the
// production client build strips template comments, which desyncs hydration.
defineProps({
  size: { type: String, default: "md" },
});

// Bound rather than written as a literal src="/icon-192.png": Vite treats a
// literal src in a template as an asset to resolve and bundle, and this file is
// not in the build graph — it is served by express from public/. Binding keeps
// it a plain runtime URL.
const LOGO_SRC = "/icon-192.png";

// The header carries the wordmark AND three nav links. Jersey 25 is wider than
// the display face it replaced, and at 360px the full-size lockup pushed the
// last nav link off-screen — hence the step down below 420px, the same width at
// which ": Step Challenges" drops out.
const SIZES = {
  md: {
    img: "size-6 min-[380px]:size-7 min-[420px]:size-[34px]",
    text: "text-[1.35rem] min-[380px]:text-[1.6rem] min-[420px]:text-[2rem] sm:text-[2.15rem]",
  },
  sm: { img: "size-[26px]", text: "text-[1.55rem]" },
};
</script>

<template>
  <a
    href="/"
    aria-label="Bara: Step Challenges"
    class="inline-flex items-center gap-2.5 text-foreground transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
  >
    <img
      :src="LOGO_SRC"
      alt=""
      width="192"
      height="192"
      :class="['shrink-0 rounded-lg', SIZES[size].img]"
    />
    <span
      aria-hidden="true"
      :class="['font-wordmark leading-none tracking-[0.01em]', SIZES[size].text]"
    >
      Bara<span class="hidden text-primary min-[420px]:inline">: Step Challenges</span>
    </span>
  </a>
</template>
