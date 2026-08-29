import type { TwinData } from "../../types";
import { fmtClock } from "../../utils";
import { ROLE_LABEL, type RoleId } from "./nav";

const PLANT_LABEL = "Final Assembly A";

export function TopHeader({
  twin,
  role,
  user,
  onLogout,
  onOpenDrawer,
}: {
  twin: TwinData;
  role: RoleId;
  user: { displayName: string };
  onLogout: () => void;
  onOpenDrawer: () => void;
}) {
  const m = twin.meta;
  const shiftWindow = `${fmtClock(0)}–${fmtClock(m.horizon_s)}`;

  return (
    <header className="topheader">
      <div className="topheader-left">
        <button
          type="button"
          className="topheader-burger"
          onClick={onOpenDrawer}
          aria-label="Open navigation"
        >
          <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <span className="topheader-title">TwinFlow</span>
        <span className="topheader-desc">Predictive digital twin</span>
      </div>

      <div className="topheader-meta">
        <Meta label="Plant" value={PLANT_LABEL} />
        <Meta label="Run seed" value={String(m.seed)} mono />
        <Meta label="Stations" value={String(m.n_stations)} mono />
        <Meta label="Shift horizon" value={`${(m.horizon_s / 3600).toFixed(0)}h`} mono />
        <Meta label="Shift window" value={shiftWindow} mono />
      </div>

      <div className="topheader-right">
        <span className="role-chip">{ROLE_LABEL[role]}</span>
        <span className="topheader-user">{user.displayName}</span>
        <button className="logout-btn" onClick={onLogout}>
          Sign out
        </button>
      </div>
    </header>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="topheader-meta-item">
      <span className="topheader-meta-label">{label}</span>
      <span className={`topheader-meta-value${mono ? " mono" : ""}`}>{value}</span>
    </div>
  );
}
