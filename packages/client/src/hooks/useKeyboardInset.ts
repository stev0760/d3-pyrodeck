import { useEffect, useState } from "react";

/**
 * How much of the layout viewport the on-screen keyboard covers, in CSS
 * pixels. iOS Safari does not shrink the layout viewport for its keyboard
 * (Chrome on Android does with `interactive-widget=resizes-content`), so a
 * shell that fills `100dvh` pads its bottom by this much to keep the input
 * bar in view. Zero when no keyboard is up or the browser resizes the layout
 * itself.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      setInset(covered > 40 ? Math.round(covered) : 0);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    update();
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);
  return inset;
}
