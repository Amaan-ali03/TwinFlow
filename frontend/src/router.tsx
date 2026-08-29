import {
  createRoute,
  createRootRouteWithContext,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { LoginPage } from "./components/LoginPage";
import { AppShell } from "./components/shell/AppShell";
import type { RoleId } from "./components/shell/nav";
import { FloorView } from "./components/floor/FloorView";
import { LeadershipView } from "./components/leadership/LeadershipView";
import { ManagerView } from "./components/manager/ManagerView";
import {
  loadTwinData,
  loadValidationData,
  type ValidationProgress,
} from "./dataLoader";
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

type Role = RoleId;

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
    throw redirect({
      to: context.user ? pathForRole(context.user.role) : "/login",
    });
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

/* ---------------------------------------------------------------------------
 * Shared data contexts — one twin load per role session, one validation SSE
 * run shared across every Leadership sub-view.
 * ------------------------------------------------------------------------- */

const DashboardDataContext = createContext<{ twin: TwinData } | null>(null);

export function useDashboardData() {
  const data = useContext(DashboardDataContext);
  if (!data) throw new Error("Dashboard data is unavailable");
  return data;
}

interface ValidationState {
  validation: ValidationData | null;
  validationProgress: ValidationProgress | null;
  validationError: string | null;
}

const ValidationDataContext = createContext<ValidationState | null>(null);

export function useValidationData() {
  const data = useContext(ValidationDataContext);
  if (!data) throw new Error("Validation data is unavailable");
  return data;
}

/* ---------------------------------------------------------------------------
 * Role layout — application shell + role-scoped data provider around <Outlet/>.
 * ------------------------------------------------------------------------- */

function RoleLayout({ role }: { role: RoleId }) {
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

  const [validation, setValidation] = useState<ValidationData | null>(null);
  const [validationProgress, setValidationProgress] =
    useState<ValidationProgress | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (role !== "leadership") return;
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
  }, [role]);

  if (!user) return null;
  if (error) return <div className="error">{error}</div>;
  if (!twin) return <div className="loading">Loading simulation…</div>;

  return (
    <DashboardDataContext.Provider value={{ twin }}>
      <ValidationDataContext.Provider
        value={{ validation, validationProgress, validationError }}
      >
        <AppShell
          role={role}
          twin={twin}
          user={{ displayName: user.displayName }}
          onLogout={logout}
        >
          <Outlet />
        </AppShell>
      </ValidationDataContext.Provider>
    </DashboardDataContext.Provider>
  );
}

/* ---------------------------------------------------------------------------
 * Role screens. Foundation phase: every sub-route of a role renders that
 * role's existing view. Per-tab content restructuring lands in the next
 * phases — the routes and navigation exist now so the shell is reviewable.
 * ------------------------------------------------------------------------- */

function FloorScreen() {
  const { twin } = useDashboardData();
  return <FloorView twin={twin} />;
}

function ManagerScreen() {
  const { twin } = useDashboardData();
  return <ManagerView twin={twin} />;
}

function LeadershipScreen() {
  const { twin } = useDashboardData();
  const { validation, validationProgress, validationError } = useValidationData();
  if (validationError) return <div className="error">{validationError}</div>;
  return (
    <LeadershipView
      twin={twin}
      validation={validation}
      validationProgress={validationProgress}
    />
  );
}

const FLOOR_PATHS = [
  "overview",
  "live-line",
  "alerts",
  "bottlenecks",
  "station",
] as const;
const MANAGER_PATHS = [
  "overview",
  "live-performance",
  "alerts",
  "bottlenecks",
  "quality",
  "diagnostics",
  "history",
] as const;
const LEADERSHIP_PATHS = [
  "overview",
  "model-performance",
  "reliability",
  "root-cause",
  "business-case",
  "risks",
] as const;

/** Build a role's route subtree: a layout route with an index redirect plus one
 *  child route per navigation path, all rendering `screen` for now. Per-tab
 *  content restructuring lands in the next phases. */
function roleRoutes<const P extends readonly string[]>(
  role: RoleId,
  paths: P,
  screen: () => ReactNode
) {
  const layout = createRoute({
    getParentRoute: () => rootRoute,
    path: `/${role}`,
    beforeLoad: requireRole(role),
    component: () => <RoleLayout role={role} />,
  });

  const index = createRoute({
    getParentRoute: () => layout,
    path: "/",
    beforeLoad: () => {
      // Routes assembled in this helper resolve at runtime but don't surface in
      // the router's static path union, so the target is cast here.
      throw redirect({ to: `/${role}/${paths[0]}` as unknown as "/floor" });
    },
  });

  const children = paths.map((p) =>
    createRoute({
      getParentRoute: () => layout,
      path: p,
      component: screen,
    })
  );

  return layout.addChildren([index, ...children]);
}

const routeTree = rootRoute.addChildren([
  indexRoute,
  loginRoute,
  roleRoutes("floor", FLOOR_PATHS, FloorScreen),
  roleRoutes("manager", MANAGER_PATHS, ManagerScreen),
  roleRoutes("leadership", LEADERSHIP_PATHS, LeadershipScreen),
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
