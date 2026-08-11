<script setup>
// The Google Play icon, as inline SVG.
//
// It marks the platform beside the word "Android" — it is NOT a store link and
// NOT the "Get it on Google Play" badge, deliberately: the app is not on Play
// yet, and a store badge would advertise a listing that does not exist. The
// whole section exists to say "not yet, leave your email".
//
// Four triangles sharing the left-hand apex, each with its own gradient. This
// is Google's mark; if it ever needs to be exact, replace this with the official
// asset from Google's brand resources rather than adjusting the geometry here.
//
// No HTML comments in the template — these pages are prerendered and the
// production client build strips template comments, desyncing hydration.
</script>

<template>
  <svg
    viewBox="0 0 512 566"
    role="img"
    aria-label="Google Play"
    class="h-9 w-auto shrink-0"
  >
    <defs>
      <linearGradient id="gp-green" x1="0" y1="0" x2="1" y2="0.5">
        <stop offset="0%" stop-color="#00A0FF" />
        <stop offset="100%" stop-color="#00E3FF" />
      </linearGradient>
      <linearGradient id="gp-a" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#00C3FF" />
        <stop offset="100%" stop-color="#00E1B4" />
      </linearGradient>
      <linearGradient id="gp-b" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#FFE000" />
        <stop offset="100%" stop-color="#FF9C00" />
      </linearGradient>
      <linearGradient id="gp-c" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#FF3A44" />
        <stop offset="100%" stop-color="#C31162" />
      </linearGradient>
      <linearGradient id="gp-d" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#32A071" />
        <stop offset="100%" stop-color="#00D46A" />
      </linearGradient>
    </defs>

    <path d="M12 12 C4 21 0 34 0 51 v464 c0 17 4 30 12 39 l2 2 260-260 v-6 L14 10 z" fill="url(#gp-a)" />
    <path d="M360 396 l-86-86 v-6 l86-87 2 1 103 58 c29 17 29 44 0 61 l-103 58 z" fill="url(#gp-b)" />
    <path d="M362 395 L274 307 12 569 c10 10 25 11 43 1 l307-175" fill="url(#gp-c)" />
    <path d="M362 171 L55 -4 C37 -14 22 -13 12 -3 l262 262 z" fill="url(#gp-d)" />
  </svg>
</template>
