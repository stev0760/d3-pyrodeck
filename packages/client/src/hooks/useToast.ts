import { useState, useCallback, useRef, useEffect } from "react";

export interface Toast {
  id: number;
  message: string;
  type: "error" | "info";
}

const TOAST_DURATION_MS = 5000;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
    };
  }, []);

  const addToast = useCallback((message: string, type: "error" | "info" = "error") => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, type }]);
    const timer = setTimeout(() => {
      timersRef.current.delete(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
    timersRef.current.set(id, timer);
  }, []);

  const dismissToast = useCallback((id: number) => {
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return { toasts, addToast, dismissToast };
}
