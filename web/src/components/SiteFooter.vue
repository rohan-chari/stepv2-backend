<script setup>
// Wordmark + links, nothing else.
//
// The footer used to carry a second walking capybara over a dashed rule, as a
// closing beat. It came out once the hero gained the app's real trail: two
// capybaras walking two different grounds on one page read as a repeated trick
// rather than a motif, and the footer's job is just to be a footer.
//
// No HTML comments in the template: these pages are prerendered and the
// production client build strips template comments, which would desync
// hydration on every page that renders this footer.
import BaraWordmark from "@/components/BaraWordmark.vue";
</script>

<template>
  <footer class="border-t border-border/70 bg-canopy-deep">
    <div class="mx-auto max-w-6xl px-5 py-12 sm:px-8">
      <div
        class="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between"
      >
        <BaraWordmark size="sm" />

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
