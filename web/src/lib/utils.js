import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// shadcn's class helper: merge conditional classes, with later Tailwind
// utilities correctly overriding earlier ones of the same property.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
