<script setup>
import { useAttrs } from "vue";
import { cn } from "@/lib/utils";

defineOptions({ inheritAttrs: false });

const props = defineProps({
  modelValue: { type: [String, Number], default: "" },
  class: { type: null, default: "" },
});
const emit = defineEmits(["update:modelValue"]);
const attrs = useAttrs();
</script>

<template>
  <input
    v-bind="attrs"
    :value="modelValue"
    :class="
      cn(
        // Styled for the beige surface: the only place an Input appears is the
        // waitlist form on the paper home page.
        'flex h-11 w-full rounded-md border border-paper-border bg-paper px-4 py-2 font-body text-base text-paper-foreground shadow-[inset_0_2px_0_0_rgba(26,43,34,0.08)] transition-colors placeholder:text-paper-muted focus-visible:border-paper-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-paper-accent/35 disabled:cursor-not-allowed disabled:opacity-55',
        props.class
      )
    "
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
