<script setup>
// The trail runs out here: one last capybara walking the full width of the
// footer, same sprite and same traverse as the hero but quieter — a closing
// beat, not a second headline. pt reserves the sprite's height, since it is
// absolutely positioned above a 1px rule that has no height of its own.
//
// No HTML comments in the template: these pages are prerendered and the
// production client build strips template comments, which would desync
// hydration on every page that renders this footer.
import capySprite from "@/assets/capybara_walk_right.png";
</script>

<template>
  <footer class="border-t border-border/70 bg-canopy-deep">
    <div class="mx-auto max-w-6xl px-5 py-12 sm:px-8">
      <div class="relative mb-8 pt-16 sm:pt-20" aria-hidden="true">
        <div class="capy-runner bottom-0 opacity-80">
          <div
            class="capy-walk"
            :style="{ '--capy-sprite': `url(${capySprite})` }"
          />
        </div>
        <div
          class="h-px w-full bg-[repeating-linear-gradient(to_right,var(--border)_0_10px,transparent_10px_18px)]"
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
