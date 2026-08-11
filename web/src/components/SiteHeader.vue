<script setup>
// Shared across all three pages. `current` dims the link to the page you're
// already on rather than hiding it — the nav stays the same shape everywhere,
// so it never reflows between pages.
import BaraWordmark from "@/components/BaraWordmark.vue";

defineProps({
  current: { type: String, default: "" },
});

const links = [
  { href: "/", label: "Home", key: "home" },
  { href: "/support", label: "Support", key: "support" },
  { href: "/privacy", label: "Privacy", key: "privacy" },
];
</script>

<template>
  <header class="border-b border-border/70 bg-background">
    <div
      class="mx-auto flex h-16 max-w-6xl items-center justify-between gap-6 px-5 sm:px-8"
    >
      <BaraWordmark />

      <nav aria-label="Site" class="flex items-center gap-1 sm:gap-2">
        <a
          v-for="link in links"
          :key="link.key"
          :href="link.href"
          :aria-current="current === link.key ? 'page' : undefined"
          class="eyebrow rounded-sm px-1.5 py-2 text-[0.68rem] tracking-[0.1em] transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring min-[420px]:tracking-[0.18em] sm:px-3 sm:text-xs"
          :class="
            current === link.key
              ? 'text-primary'
              : 'text-muted-foreground'
          "
        >
          {{ link.label }}
        </a>
      </nav>
    </div>
  </header>
</template>
