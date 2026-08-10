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
        'flex h-11 w-full rounded-md border border-input bg-canopy-deep px-4 py-2 font-body text-base text-foreground shadow-[inset_0_2px_0_0_rgba(0,0,0,0.25)] transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-55',
        props.class
      )
    "
    @input="emit('update:modelValue', $event.target.value)"
  />
</template>
