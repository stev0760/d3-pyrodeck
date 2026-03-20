import { useState, type FormEvent } from "react";

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
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-zinc-100">D3 Pyrodeck</h1>
          <p className="text-zinc-500 mt-1">Descent 3 Server Admin</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-zinc-900 border border-zinc-800 rounded-lg p-6"
        >
          <label className="block text-sm font-medium text-zinc-400 mb-2">
            Admin Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-3 py-2 bg-zinc-800 border border-zinc-700 rounded-md text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            placeholder="Enter password"
            autoFocus
            disabled={loading}
          />

          {error && (
            <p className="mt-2 text-sm text-red-400">Invalid password</p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="mt-4 w-full py-2 px-4 bg-amber-600 hover:bg-amber-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white font-medium rounded-md transition-colors"
          >
            {loading ? "Authenticating..." : "Log In"}
          </button>
        </form>
      </div>
    </div>
  );
}
