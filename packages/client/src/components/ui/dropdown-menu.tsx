import * as React from "react"
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

function DropdownMenu(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Root>,
) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuTrigger(
  props: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>,
) {
  return (
    <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
  )
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  align = "start",
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        align={align}
        className={cn(
          "z-50 min-w-[8rem] overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  active,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  active?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-active={active ? "" : undefined}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 pr-8 text-sm outline-none transition-colors",
        "text-foreground/80 focus:bg-accent focus:text-accent-foreground",
        "data-active:text-foreground data-active:font-medium",
        "data-disabled:pointer-events-none data-disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {props.children}
      {active && <Check className="absolute right-2 size-4 text-primary" />}
    </DropdownMenuPrimitive.Item>
  )
}

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
}
