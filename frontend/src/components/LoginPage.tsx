import { useState } from "react";

export function LoginPage({
  onLogin,
}: {
  onLogin: (role: string, displayName: string, token: string) => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.detail || "Invalid credentials");
      }
      const data = await res.json();
      onLogin(data.role, data.display_name, data.token);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-brand">
          <div className="brand-mark">TF</div>
          <h1>TwinFlow</h1>
        </div>
        <p className="login-sub">
          Predictive digital twin — mixed model assembly line
        </p>
        <form onSubmit={handleSubmit}>
          <label className="login-label">
            Username
            <input
              className="login-input"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="login-label">
            Password
            <input
              className="login-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          {error && <div className="login-error">{error}</div>}
          <button className="login-btn" type="submit" disabled={loading}>
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
