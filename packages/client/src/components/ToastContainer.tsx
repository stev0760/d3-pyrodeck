import type { Toast } from "../hooks/useToast.ts";

interface ToastContainerProps {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`px-4 py-3 rounded border text-sm shadow-lg flex items-start gap-2 ${
            toast.type === "error"
              ? "bg-red-950/90 border-red-800/50 text-red-300"
              : "bg-zinc-800/90 border-zinc-700/50 text-zinc-300"
          }`}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            className="text-zinc-500 hover:text-zinc-300 shrink-0"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
