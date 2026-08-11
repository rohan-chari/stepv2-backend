<script setup>
import SiteHeader from "@/components/SiteHeader.vue";
import SiteFooter from "@/components/SiteFooter.vue";

// Q&A copy carried over verbatim from the previous public/support.html — the
// answers are troubleshooting instructions and must not be paraphrased.
//
// The `html` field is rendered with v-html in the template. That is safe here
// and ONLY here because these strings are authored in this file and never
// contain user input; anything user-controlled must go through interpolation.
//
// No HTML comments in the template — see the note in HomePage.vue.
const questions = [
  {
    q: "Steps not showing up?",
    html: "Check that Bara has permission to read your steps. On <strong>iOS</strong>: Settings → Privacy &amp; Security → Health → Bara, and make sure Steps is enabled. On <strong>Android</strong>: open Health Connect (or Settings → Security &amp; privacy → Health Connect) → app permissions → Bara, and allow Steps.",
  },
  {
    q: "Steps not syncing to challenges?",
    html: "Open the app and pull to refresh on the Home tab. Background sync runs on its own, but a manual refresh updates immediately. Make sure you have an internet connection.",
  },
  {
    q: "Not receiving challenge notifications?",
    html: "On <strong>iOS</strong>: Settings → Notifications → Bara, and make sure notifications are allowed. On <strong>Android</strong>: Settings → Apps → Bara → Notifications. If you previously denied them, you'll need to enable them from Settings. The app won't ask again.",
  },
  {
    q: "Can't find a friend?",
    html: "Your friend needs a display name set in Bara. Search requires at least 2 characters and matches on display names only.",
  },
  {
    q: "Sign-in issues?",
    html: "Bara signs you in with Apple or Google on iOS, and with Google on Android. Make sure you're signed into that account in your device settings and that you have a working internet connection.",
  },
  {
    q: "Want your account deleted?",
    html: 'Email <a href="mailto:support@barastep.com?subject=Delete%20my%20Bara%20account">support@barastep.com</a> and we\'ll remove your account and all of its data within 30 days. See the <a href="/privacy">Privacy Policy</a> for what we store.',
  },
];
</script>

<template>
  <SiteHeader current="support" />

  <main class="paper">
    <div class="mx-auto max-w-3xl px-5 py-16 sm:px-8 sm:py-20">
      <h1
        class="font-display text-[clamp(2.25rem,6vw,3.5rem)] leading-[1.02] font-extrabold tracking-[-0.03em] text-[var(--paper-foreground)]"
      >
        Support
      </h1>
      <p
        class="mt-5 mb-12 font-body text-lg leading-relaxed text-[var(--paper-muted)]"
      >
        Questions, feedback, or a bug on the trail. All welcome. Email
        <a
          class="font-medium text-[var(--paper-foreground)] underline decoration-[var(--primary)] decoration-2 underline-offset-4"
          href="mailto:support@barastep.com?subject=Bara%20Support"
          >support@barastep.com</a
        >
        and we'll get back to you as soon as we can.
      </p>

      <div class="prose-bara">
        <h2>Common trail troubles</h2>

        <div
          v-for="item in questions"
          :key="item.q"
          class="border-t border-[var(--paper-border)] py-6"
        >
          <h3
            class="mb-2 font-display text-lg font-bold text-[var(--paper-foreground)]"
          >
            {{ item.q }}
          </h3>
          <p class="!mb-0" v-html="item.html" />
        </div>
      </div>
    </div>
  </main>

  <SiteFooter />
</template>
