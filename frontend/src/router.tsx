import { createRoute, createRootRouteWithContext, createRouter, Outlet, redirect, useNavigate } from "@tanstack/react-router";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Header } from "./components/Header";
import { LoginPage } from "./components/LoginPage";
import { FloorView } from "./components/floor/FloorView";
import { LeadershipView } from "./components/leadership/LeadershipView";
import { ManagerView } from "./components/manager/ManagerView";
import { loadTwinData, loadValidationData, type ValidationProgress } from "./dataLoader";
import type { TwinData, ValidationData } from "./types";

export interface AuthUser {
  role: string;
  displayName: string;
  token: string;
}

interface RouterContext {
  user: AuthUser | null;
  authChecked: boolean;
  login: (user: AuthUser) => void;
  logout: () => void;
}

type Role = "floor" | "manager" | "leadership";

const ROLE_PATHS: Record<Role, "/floor" | "/manager" | "/leadership"> = {
  floor: "/floor",
  manager: "/manager",
  leadership: "/leadership",
};

function pathForRole(role: string) {
  return ROLE_PATHS[role as Role] ?? ROLE_PATHS.floor;
}

function requireRole(role: Role) {
  return ({ context }: { context: RouterContext }) => {
    if (!context.user) throw redirect({ to: "/login" });
    if (context.user.role !== role) {
      throw redirect({ to: pathForRole(context.user.role) });
    }
  };
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: Outlet,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: ({ context }) => {
    throw redirect({ to: context.user ? pathForRole(context.user.role) : "/login" });
  },
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: ({ context }) => {
    if (context.user) throw redirect({ to: pathForRole(context.user.role) });
  },
  component: LoginRoute,
});

const floorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/floor",
  beforeLoad: requireRole("floor"),
  component: FloorRoute,
});

const managerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/manager",
  beforeLoad: requireRole("manager"),
  component: ManagerRoute,
});

const leadershipRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/leadership",
  beforeLoad: requireRole("leadership"),
  component: LeadershipRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  floorRoute,
  managerRoute,
  leadershipRoute,
]);

export const router = createRouter({
  routeTree,
  context: {
    user: null,
    authChecked: false,
    login: () => {},
    logout: () => {},
  },
  defaultNotFoundComponent: () => <div className="error">Page not found.</div>,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

function LoginRoute() {
  const { user, login } = loginRoute.useRouteContext();
  const navigate = useNavigate();

  useEffect(() => {
    if (user) navigate({ to: pathForRole(user.role), replace: true });
  }, [navigate, user]);

  return (
    <LoginPage
      onLogin={(role, displayName, token) => {
        login({ role, displayName, token });
      }}
    />
  );
}

interface DashboardData {
  twin: TwinData;
}

const DashboardDataContext = createContext<DashboardData | null>(null);

function useDashboardData() {
  const data = useContext(DashboardDataContext);
  if (!data) throw new Error("Dashboard data is unavailable");
  return data;
}

function DashboardLayout({ children }: { children: ReactNode }) {
  const { user, logout } = rootRoute.useRouteContext();
  const [twin, setTwin] = useState<TwinData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setTwin(null);
    setError(null);
    loadTwinData()
      .then((data) => active && setTwin(data))
      .catch((requestError: Error) => active && setError(requestError.message));
    return () => {
      active = false;
    };
  }, []);

  if (!user) return null;
  if (error) return <div className="error">{error}</div>;
  if (!twin) return <div className="loading">Loading simulation...</div>;

  return (
    <DashboardDataContext.Provider value={{ twin }}>
      <Header twin={twin} user={user} onLogout={logout} />
      <div className="wrap">{children}</div>
    </DashboardDataContext.Provider>
  );
}

function FloorRoute() {
  return (
    <DashboardLayout>
      <FloorDashboard />
    </DashboardLayout>
  );
}

function FloorDashboard() {
  const { twin } = useDashboardData();
  return <FloorView twin={twin} />;
}

function ManagerRoute() {
  return (
    <DashboardLayout>
      <ManagerDashboard />
    </DashboardLayout>
  );
}

function ManagerDashboard() {
  const { twin } = useDashboardData();
  return <ManagerView twin={twin} />;
}

function LeadershipRoute() {
  return (
    <DashboardLayout>
      <LeadershipDashboard />
    </DashboardLayout>
  );
}

function LeadershipDashboard() {
  const { twin } = useDashboardData();
  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validationProgress, setValidationProgress] = useState<ValidationProgress | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setValidationError(null);
    loadValidationData((progress) => active && setValidationProgress(progress))
      .then((data) => active && setValidation(data))
      .catch((requestError: Error) => {
        if (active) setValidationError(requestError.message);
      });
    return () => {
      active = false;
    };
  }, []);

  if (validationError) return <div className="error">{validationError}</div>;

  return (
    <LeadershipView
      twin={twin}
      validation={validation}
      validationProgress={validationProgress}
    />
  );
}
