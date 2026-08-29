import { useEffect, useState, type ReactNode } from "react";
import type { TwinData } from "../../types";
import { Sidebar } from "./Sidebar";
import { TopHeader } from "./TopHeader";
import type { RoleId } from "./nav";

const COLLAPSE_KEY = "twinflow_sidebar_collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppShell({
  role,
  twin,
  user,
  onLogout,
  children,
}: {
  role: RoleId;
  twin: TwinData;
  user: { displayName: string };
  onLogout: () => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [narrow, setNarrow] = useState(false);

  // Below the drawer breakpoint the rail state is meaningless — the sidebar is
  // either off-canvas or full-width, always with labels.
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 860px)");
    const sync = () => setNarrow(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    } catch {
      /* private window — the rail just won't be remembered */
    }
  }, [collapsed]);

  // Close the mobile drawer on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setDrawerOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const railCollapsed = collapsed && !narrow;

  return (
    <div
      className={`app-shell${railCollapsed ? " sidebar-collapsed" : ""}${
        drawerOpen ? " drawer-open" : ""
      }`}
    >
      <aside className="app-sidebar">
        <Sidebar
          role={role}
          collapsed={railCollapsed}
          onToggleCollapse={() => setCollapsed((c) => !c)}
          onNavigate={() => setDrawerOpen(false)}
        />
      </aside>

      <div
        className="app-scrim"
        onClick={() => setDrawerOpen(false)}
        aria-hidden="true"
      />

      <div className="app-main">
        <TopHeader
          twin={twin}
          role={role}
          user={user}
          onLogout={onLogout}
          onOpenDrawer={() => setDrawerOpen(true)}
        />
        <main className="app-content">{children}</main>
      </div>
    </div>
  );
}
