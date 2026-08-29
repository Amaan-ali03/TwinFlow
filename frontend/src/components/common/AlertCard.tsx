import { useState } from "react";
import type { Alert } from "../../types";
import { fmtT } from "../../utils";
import { Drawer } from "./Drawer";

function tierClass(tier: string) {
  return tier === "ACT NOW" ? "act" : tier === "ADVISE" ? "advise" : "monitor";
}

function bodiesAffected(a: Alert) {
  const n = a.severity_units && a.severity_units > 0
    ? a.severity_units
    : a.at_risk_ranked?.length ?? 0;
  return Math.round(n);
}

export function firstSentence(s: string) {
  const m = s.match(/^.*?[.!?](\s|$)/);
  return m ? m[0].trim() : s;
}

function OutcomeBadge({ a, nowT }: { a: Alert; nowT: number }) {
  if (nowT < a.verify_by) {
    return <span className="outbadge ob-open">verifies {fmtT(a.verify_by)}</span>;
  }
  if (a.outcome === "OPEN") return <span className="outbadge ob-open">OPEN</span>;
  if (a.outcome === "PENDING") return <span className="outbadge ob-pending">PENDING</span>;
  if (a.outcome === "TRUE") {
    return (
      <span className="outbadge ob-true">
        CONFIRMED · lead {a.lead_time_s ? `${(a.lead_time_s / 60).toFixed(0)}m` : "—"}
      </span>
    );
  }
  return <span className="outbadge ob-false">FALSE ALARM</span>;
}

/**
 * Levels 1–2 on the card (what / how urgent); Levels 3–5 (why / evidence /
 * action detail / containment) open in a drawer.
 */
export function AlertCard({
  alert,
  nowT = Number.MAX_SAFE_INTEGER,
}: {
  alert: Alert;
  nowT?: number;
}) {
  const [tab, setTab] = useState<"evidence" | "containment" | null>(null);
  const tc = tierClass(alert.tier);
  const affected = bodiesAffected(alert);
  const hasContainment = (alert.at_risk_ranked?.length ?? 0) > 0;

  return (
    <div className={`alertcard tier-border-${tc}`}>
      <div className="alertcard-top">
        <span className={`tierbadge tb-${tc}`}>{alert.tier}</span>
        <span className="mono faint">{fmtT(alert.t)}</span>
        {alert.updates > 0 && (
          <span className="faint">
            updated {alert.updates}×, last {fmtT(alert.last_update_t)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <OutcomeBadge a={alert} nowT={nowT} />
      </div>

      <div className="alertcard-head">{alert.headline}</div>

      <div className="alertcard-stats mono">
        <span>
          Risk <b style={{ color: "var(--andon-amber)" }}>{alert.risk}</b>
        </span>
        {affected > 0 && (
          <span>
            ≈{affected} {affected === 1 ? "body" : "bodies"} at risk
          </span>
        )}
        <span className="faint">confidence {(alert.confidence * 100).toFixed(0)}%</span>
      </div>

      <div className="alertcard-action">
        <b>Action —</b> {firstSentence(alert.action)}
      </div>
      <div className="alertcard-meta faint">{alert.owner}</div>

      <div className="alertcard-buttons">
        <button className="pillbtn" onClick={() => setTab("evidence")}>
          View evidence
        </button>
        {hasContainment && (
          <button className="pillbtn" onClick={() => setTab("containment")}>
            Containment
          </button>
        )}
      </div>

      <Drawer
        open={tab !== null}
        onClose={() => setTab(null)}
        title={alert.headline}
        subtitle={
          <>
            <span className={`tierbadge tb-${tc}`}>{alert.tier}</span>{" "}
            Risk {alert.risk} · confidence {(alert.confidence * 100).toFixed(0)}%
          </>
        }
      >
        {hasContainment && (
          <div className="drawer-tabs">
            <button
              className={tab === "evidence" ? "is-active" : ""}
              onClick={() => setTab("evidence")}
            >
              Evidence
            </button>
            <button
              className={tab === "containment" ? "is-active" : ""}
              onClick={() => setTab("containment")}
            >
              Containment ({alert.at_risk_ranked.length})
            </button>
          </div>
        )}

        {tab === "evidence" && (
          <div className="drawer-section">
            <div className="drawer-kv">
              <span>Recommended action</span>
              <span>{alert.action}</span>
            </div>
            <div className="drawer-kv">
              <span>Owner</span>
              <span>{alert.owner}</span>
            </div>
            <div className="drawer-kv">
              <span>Expected impact</span>
              <span>{alert.expected_impact}</span>
            </div>
            <div className="drawer-kv">
              <span>Verifies by</span>
              <span className="mono">{fmtT(alert.verify_by)}</span>
            </div>

            <h4 className="drawer-h">Evidence ({alert.evidence.length})</h4>
            <ul className="drawer-list">
              {alert.evidence.map((e, j) => (
                <li key={j}>{e}</li>
              ))}
            </ul>

            <h4 className="drawer-h">Falsifier</h4>
            <p className="drawer-p">{alert.falsifier}</p>
          </div>
        )}

        {tab === "containment" && hasContainment && (
          <div className="drawer-section">
            <p className="drawer-p faint">
              Bodies ranked by likely-contributor score. Not root cause — inspect
              the highest ranked first.
            </p>
            <table className="datatable">
              <thead>
                <tr>
                  <th>Body</th>
                  <th className="num">Contributor risk</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {alert.at_risk_ranked.slice(0, 40).map((b) => (
                  <tr key={b.uid}>
                    <td className="mono">#{b.uid}</td>
                    <td className="num mono">
                      {b.risk === null ? (
                        <span className="faint">no process data</span>
                      ) : (
                        `${(b.risk * 100).toFixed(1)}%`
                      )}
                    </td>
                    <td className="faint">
                      {b.status === "on_line" ? "still on line" : "rolled out"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {alert.at_risk_ranked.length > 40 && (
              <p className="drawer-p faint">
                +{alert.at_risk_ranked.length - 40} more, lower ranked
              </p>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
