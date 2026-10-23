import { useCallback, useState } from "react";

const KEY = "pyrodeck-cmd-history";
const MAX = 50;

function read(): string[] {
  try {
    const raw = sessionStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Commands typed this browser session, most recent first, without repeats. */
export function useCommandHistory() {
  const [history, setHistory] = useState<string[]>(read);
  const remember = useCallback((command: string) => {
    setHistory((prev) => {
      const next = [command, ...prev.filter((c) => c !== command)].slice(0, MAX);
      try {
        sessionStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // storage unavailable: history lasts for this page only
      }
      return next;
    });
  }, []);
  return { history, remember };
}
