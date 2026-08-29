import { Link } from "@tanstack/react-router";
import { NAV, ROLE_LABEL, type RoleId } from "./nav";

export function Sidebar({
  role,
  collapsed,
  onToggleCollapse,
  onNavigate,
}: {
  role: RoleId;
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** called after any nav item is chosen — lets the mobile drawer close itself */
  onNavigate?: () => void;
}) {
  const groups = NAV[role];

  return (
    <div className={`sidebar${collapsed ? " is-collapsed" : ""}`}>
      <div className="sidebar-brand">
        <div className="brand-mark">TF</div>
        {!collapsed && (
          <div className="sidebar-brand-text">
            <span className="sidebar-brand-name">TwinFlow</span>
            <span className="sidebar-brand-role">{ROLE_LABEL[role]}</span>
          </div>
        )}
      </div>

      <nav className="sidebar-nav">
        {groups.map((group) => (
          <div className="sidebar-group" key={group.heading}>
            {!collapsed && (
              <div className="sidebar-heading">{group.heading}</div>
            )}
            {group.items.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className="sidebar-link"
                activeProps={{ className: "is-active" }}
                activeOptions={{ exact: true }}
                title={collapsed ? item.label : undefined}
                onClick={() => onNavigate?.()}
              >
                <span className="sidebar-ico">{item.icon}</span>
                {!collapsed && <span className="sidebar-label">{item.label}</span>}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <button
        type="button"
        className="sidebar-collapse"
        onClick={onToggleCollapse}
        title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      >
        <svg
          width={16}
          height={16}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ transform: collapsed ? "rotate(180deg)" : "none" }}
        >
          <path d="m15 6-6 6 6 6" />
        </svg>
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  );
}
