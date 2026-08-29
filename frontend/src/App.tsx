import { useCallback, useEffect, useState } from "react";
import { RouterProvider } from "@tanstack/react-router";
import { router, type AuthUser } from "./router";

const AUTH_STORAGE_KEY = "twinflow_auth";

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!saved) {
      setAuthChecked(true);
      return;
    }

    try {
      const parsed = JSON.parse(saved) as AuthUser;
      fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${parsed.token}` },
      })
        .then((response) => {
          if (!response.ok) throw new Error("expired");
          return response.json();
        })
        .then((data) => {
          setUser({
            ...parsed,
            role: data.role,
            displayName: data.display_name,
          });
        })
        .catch(() => localStorage.removeItem(AUTH_STORAGE_KEY))
        .finally(() => setAuthChecked(true));
    } catch {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      setAuthChecked(true);
    }
  }, []);

  const login = useCallback((nextUser: AuthUser) => {
    setUser(nextUser);
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(nextUser));
  }, []);

  const logout = useCallback(() => {
    if (user) {
      fetch("/api/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${user.token}` },
      }).catch(() => {});
    }
    setUser(null);
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }, [user]);

  useEffect(() => {
    if (authChecked) void router.invalidate();
  }, [authChecked, user]);

  if (!authChecked) return <div className="loading">Loading...</div>;

  return (
    <RouterProvider
      router={router}
      context={{ user, authChecked, login, logout }}
    />
  );
}
