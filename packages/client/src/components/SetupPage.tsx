import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

interface SetupPageProps {
  onSetup: (password: string) => Promise<{ ok: boolean; error?: string }>;
}

export function SetupPage({ onSetup }: SetupPageProps) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    if (password !== confirm) {
      setError("Passwords do not match");
      setConfirm("");
      return;
    }

    setLoading(true);
    const result = await onSetup(password);
    if (!result.ok) {
      setError(result.error ?? "Setup failed");
      setPassword("");
      setConfirm("");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-4xl font-logo tracking-wide text-primary">D3 Pyrodeck</h1>
          <p className="text-muted-foreground mt-1">Initial Setup</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card border border-border rounded-lg p-6 space-y-4"
        >
          <p className="text-sm text-muted-foreground">
            Create an admin password to secure the web panel. This is required
            before you can use Pyrodeck.
          </p>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Admin Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-input border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="At least 8 characters"
              autoFocus
              disabled={loading}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Confirm Password
            </label>
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full px-3 py-2 bg-input border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="Re-enter password"
              disabled={loading}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            disabled={loading || !password || !confirm}
            className="w-full"
          >
            {loading ? "Setting up..." : "Set Password & Continue"}
          </Button>

          <p className="text-xs text-muted-foreground text-center mt-2">
            You can also set <code className="text-xs">PYRODECK_ADMIN_PASSWORD</code> as
            an environment variable instead.
          </p>
        </form>
      </div>
    </div>
  );
}
