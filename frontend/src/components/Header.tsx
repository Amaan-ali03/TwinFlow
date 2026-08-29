import type { TwinData } from "../types";

export function Header({
  twin,
  user,
  onLogout,
}: {
  twin: TwinData;
  user: { role: string; displayName: string };
  onLogout: () => void;
}) {
  const m = twin.meta;
  return (
    <header>
      <div className="brand">
        <div className="brand-mark">TF</div>
        <div>
          <h1>TwinFlow</h1>
          <p>
            Predictive digital twin — mixed model assembly line, DigitalTwin.ai
            Round&nbsp;2
          </p>
        </div>
      </div>
      <div className="header-right">
        <div className="run-badge">
          run seed <b>{m.seed}</b> · {m.n_stations} stations · shift horizon{" "}
          {(m.horizon_s / 3600).toFixed(0)}h · {twin.alerts.length} alerts
          fired
        </div>
        <div className="user-badge">
          <span className="user-name">{user.displayName}</span>
          <button className="logout-btn" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
    </header>
  );
}
