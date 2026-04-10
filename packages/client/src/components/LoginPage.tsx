import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";

interface LoginPageProps {
  onLogin: (password: string) => Promise<boolean>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(false);
    setLoading(true);

    const success = await onLogin(password);
    if (!success) {
      setError(true);
      setPassword("");
    }
    setLoading(false);
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-foreground">D3 Pyrodeck</h1>
          <p className="text-muted-foreground mt-1">Descent 3 Server Admin</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-card border border-border rounded-lg p-6"
        >
          <label className="block text-sm font-medium text-muted-foreground mb-2">
            Admin Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-input border border-border rounded-md text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="Enter password"
            autoFocus
            disabled={loading}
          />

          {error && (
            <p className="mt-2 text-sm text-destructive">Invalid password</p>
          )}

          <Button
            type="submit"
            disabled={loading || !password}
            className="mt-4 w-full"
          >
            {loading ? "Authenticating..." : "Log In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
