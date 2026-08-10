<script setup>
// The trail runs out here: one last capybara walking off the page, same sprite
// as the hero but small and quiet — a closing beat, not a second headline.
//
// No HTML comments in the template: these pages are prerendered and the
// production client build strips template comments, which would desync
// hydration on every page that renders this footer.
import capySprite from "@/assets/capybara_walk_right.png";
</script>

<template>
  <footer class="border-t border-border/70 bg-canopy-deep">
    <div class="mx-auto max-w-6xl px-5 py-12 sm:px-8">
      <div class="mb-8 flex items-end gap-3 opacity-70">
        <div
          class="capy-walk shrink-0"
          :style="{ '--capy-sprite': `url(${capySprite})` }"
          aria-hidden="true"
        />
        <div
          class="mb-3 h-px flex-1 bg-[repeating-linear-gradient(to_right,var(--border)_0_10px,transparent_10px_18px)]"
          aria-hidden="true"
        />
      </div>

      <div
        class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <p class="font-display text-xl font-extrabold text-foreground">Bara</p>

        <nav class="flex flex-wrap items-center gap-x-5 gap-y-2" aria-label="Footer">
          <a
            href="/"
            class="eyebrow text-muted-foreground transition-colors hover:text-primary"
            >Home</a
          >
          <a
            href="/support"
            class="eyebrow text-muted-foreground transition-colors hover:text-primary"
            >Support</a
          >
          <a
            href="/privacy"
            class="eyebrow text-muted-foreground transition-colors hover:text-primary"
            >Privacy</a
          >
          <a
            href="mailto:support@barastep.com"
            class="eyebrow text-muted-foreground transition-colors hover:text-primary"
            >support@barastep.com</a
          >
        </nav>
      </div>
    </div>
  </footer>
</template>
