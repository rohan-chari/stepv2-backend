import { cva } from "class-variance-authority";

export { default as Button } from "./Button.vue";

// shadcn's Button, retuned for Bara: square-ish corners and a hard offset
// shadow instead of shadcn's soft default, so a button reads as a physical game
// control rather than a SaaS control. Colours come from the theme tokens, so
// none of this hardcodes a hex.
export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-display font-bold tracking-tight transition-[transform,box-shadow,background-color] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-55 active:translate-y-[3px] active:shadow-none",
  {
    variants: {
      variant: {
        // The primary CTA. Lantern gold on dark — the loudest thing on the page.
        default:
          "bg-primary text-primary-foreground shadow-[0_3px_0_0_var(--bara-canopy-deep)] hover:brightness-105",
        // Quiet action on the dark ground.
        secondary:
          "bg-secondary text-secondary-foreground border border-border shadow-[0_3px_0_0_var(--bara-canopy-deep)] hover:bg-[color-mix(in_srgb,var(--secondary)_88%,white)]",
        // Quiet action on the BEIGE ground (the marketing home page). Same
        // physical shape as the others, but its shadow and border come from the
        // paper palette — the dark variants' canopy shadow reads as a smudge on
        // parchment.
        paper:
          "bg-paper-raised text-paper-foreground border border-paper-border shadow-[0_3px_0_0_var(--paper-border)] hover:bg-paper",
        outline:
          "border border-border bg-transparent text-foreground hover:bg-secondary",
        ghost: "bg-transparent text-foreground hover:bg-secondary",
      },
      size: {
        default: "h-11 rounded-md px-5 text-[0.95rem]",
        sm: "h-9 rounded-sm px-3 text-sm",
        lg: "h-13 rounded-lg px-7 text-base",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);
