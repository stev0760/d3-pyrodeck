import { useSyncExternalStore } from "react";
import { useMediaQuery } from "./useMediaQuery.ts";

/**
 * Which layout a narrow viewport gets. "auto" is the phone shell below
 * 768 px; "desktop" keeps the full layout on a phone for whoever wants it.
 * Stored per browser.
 */
export type LayoutOverride = "auto" | "desktop";

const LAYOUT_KEY = "pyrodeck-layout";
const CHANGE_EVENT = "pyrodeck-layout-change";

export function getLayoutOverride(): LayoutOverride {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "desktop" ? "desktop" : "auto";
  } catch {
    return "auto";
  }
}

export function setLayoutOverride(value: LayoutOverride): void {
  try {
    if (value === "auto") localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, value);
  } catch {
    // storage unavailable: the choice lasts for this page only
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE_EVENT, onChange);
  };
}

export function useLayoutOverride(): LayoutOverride {
  return useSyncExternalStore(subscribe, getLayoutOverride, () => "auto");
}

/** The viewport is phone-sized (the same cut as the header's hamburger menu). */
export function useIsNarrow(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Show the phone shell: a phone-sized viewport without the desktop override. */
export function useIsMobile(): boolean {
  const narrow = useIsNarrow();
  const override = useLayoutOverride();
  return narrow && override !== "desktop";
}
