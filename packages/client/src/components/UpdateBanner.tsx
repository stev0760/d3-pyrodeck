import { useEffect, useState } from "react";
import { getJson, type UpdateStatus } from "@/lib/ops";

const DISMISS_KEY = "pyrodeck-update-dismissed";

/**
 * "Pyrodeck X.Y.Z is available": shown when GitHub has a newer release than
 * the running server. Dismissing hides that version only. A failed check
 * shows nothing.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    void getJson<UpdateStatus>("/api/update-check").then(setUpdate);
  }, []);

  if (!update?.available || !update.latest || !update.url || dismissed === update.latest) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, update.latest!);
    } catch {
      // private mode: dismissed for this page only
    }
    setDismissed(update.latest);
  };

  return (
    <div className="px-4 py-1.5 bg-primary/10 border-b border-primary/30 text-primary text-sm flex items-center justify-center gap-3 shrink-0">
      <span>
        Pyrodeck {update.latest} is available (you have {update.current}).{" "}
        <a href={update.url} target="_blank" rel="noopener noreferrer" className="underline">
          Release notes
        </a>
      </span>
      <button onClick={dismiss} className="text-muted-foreground hover:text-foreground" aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
}
