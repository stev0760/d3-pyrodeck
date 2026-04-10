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
          className={`px-4 py-3 rounded-md border text-sm shadow-lg flex items-start gap-2 ${
            toast.type === "error"
              ? "bg-destructive/10 border-destructive/30 text-destructive"
              : "bg-card border-border text-foreground"
          }`}
        >
          <span className="flex-1">{toast.message}</span>
          <button
            onClick={() => onDismiss(toast.id)}
            className="text-muted-foreground hover:text-foreground shrink-0"
          >
            &times;
          </button>
        </div>
      ))}
    </div>
  );
}
