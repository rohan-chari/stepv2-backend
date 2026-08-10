<script setup>
import { ref } from "vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// Four states, one at a time: idle -> submitting -> done | error. The success
// state REPLACES the form: once you're on the list, submitting again isn't an
// action worth offering.
//
// No HTML comments in the template — see the note in HomePage.vue (prerender +
// hydration).
const email = ref("");
const state = ref("idle");
const errorMessage = ref("");

// Mirrors the server's check (src/modules/web/waitlist/model.js). The server is
// still the authority — this only saves a round trip on an obvious typo.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function submit() {
  if (state.value === "submitting") return;

  const value = email.value.trim();
  if (!EMAIL_SHAPE.test(value) || value.length > 254) {
    state.value = "error";
    errorMessage.value = "Enter a valid email address.";
    return;
  }

  state.value = "submitting";
  errorMessage.value = "";

  try {
    const res = await fetch("/waitlist/android", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: value }),
    });

    if (!res.ok) {
      // The server returns 400 only for a malformed address; anything else is
      // ours to own, so the copy doesn't blame the person typing.
      const body = await res.json().catch(() => ({}));
      state.value = "error";
      errorMessage.value =
        body.code === "WAITLIST_INVALID_EMAIL"
          ? "Enter a valid email address."
          : "That didn't go through. Try again in a moment.";
      return;
    }

    // The server answers the same way whether this address was new or already
    // on the list, and so does this — nothing here reveals which.
    state.value = "done";
  } catch {
    state.value = "error";
    errorMessage.value = "That didn't go through. Check your connection.";
  }
}
</script>

<template>
  <div>
    <p
      v-if="state === 'done'"
      class="font-display text-xl font-bold text-paper-accent"
      role="status"
    >
      You're on the list. We'll email you when Android is ready.
    </p>

    <form v-else class="flex flex-col gap-3 sm:flex-row" novalidate @submit.prevent="submit">
      <div class="flex-1">
        <label for="waitlist-email" class="sr-only">Email address</label>
        <Input
          id="waitlist-email"
          v-model="email"
          type="email"
          name="email"
          autocomplete="email"
          inputmode="email"
          placeholder="you@example.com"
          :disabled="state === 'submitting'"
          :aria-invalid="state === 'error' ? 'true' : undefined"
          :aria-describedby="state === 'error' ? 'waitlist-error' : undefined"
          @input="state === 'error' && (state = 'idle')"
        />
      </div>

      <Button type="submit" size="lg" :disabled="state === 'submitting'">
        {{ state === "submitting" ? "Adding you…" : "Join the waitlist" }}
      </Button>
    </form>

    <p
      v-if="state === 'error'"
      id="waitlist-error"
      class="mt-2.5 font-body text-sm text-destructive-paper"
      role="alert"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>
