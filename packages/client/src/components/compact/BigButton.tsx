import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** The one action a screen is for: full width, 48 px, the panel's display font. */
export function BigButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      size="lg"
      {...props}
      className={cn("w-full h-12 text-base font-score tracking-wide rounded-xl", className)}
    />
  );
}
