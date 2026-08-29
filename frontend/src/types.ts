export interface StationMeta {
  sid: string;
  name: string;
  zone: string;
  index: number;
  tier: string;
  nominal_cycle_s: number;
  /** nominal cycle averaged over the line's build mix */
  mix_cycle_s?: number;
  variant_cycle_mult?: Record<string, number>;
  has_camera: boolean;
  is_inspection: boolean;
  manual_check: boolean;
  out_buffer_cap: number;
  params: string[];
}

export interface ZoneTotals {
  count: number;
  A: number;
  B: number;
  C: number;
}

export interface FaultWindow {
  station: string;
  kind: string;
  param: string;
  start_s: number;
  end_s: number;
  label: string;
}

export interface Frame {
  t: number;
  cyc: number[];
  cf: number[];
  st: number[];
  buf: number[];
  dr: number[];
  fc: ([1 | 2, number] | null)[];
  constraint: string | null;
  constraint_cycle: number;
  deficit: number;
  rate_loss: number;
  runway_min: number;
  units_out: number;
  new_alerts: string[];
  open_alerts: string[];
  ledger: { precision: number; fired: number };
}

export interface Alert {
  aid: string;
  t: number;
  kind: string;
  sid: string;
  headline: string;
  risk: number;
  confidence: number;
  tier: string;
  severity_units: number;
  evidence: string[];
  action: string;
  owner: string;
  expected_impact: string;
  falsifier: string;
  verify_by: number;
  lead_time_s: number | null;
  outcome: string;
  updates: number;
  last_update_t: number;
  at_risk_ranked: AtRiskBody[];
}

export interface AtRiskBody {
  uid: number;
  /** null when the station carries no process sensors for this body — the
   *  origin model has no opinion, which is not the same as low risk. */
  risk: number | null;
  status: "on_line" | "rolled_out";
}

export interface UnitRiskStation {
  sid: string;
  t: number;
  cycle_s: number | null;
  params: Record<string, number>;
  risk: number | null;
}

export interface UnitRisk {
  uid: number;
  disposition: {
    t: number;
    inspection: string;
    defect_type: string | null;
    origin_station: string | null;
    result: string;
  } | null;
  stations: UnitRiskStation[];
  likely_contributors: UnitRiskStation[];
  model_available: boolean;
}

export interface WhatIfForecast {
  constraint_sid: string;
  constraint_cycle_s: number;
  rate_loss_per_hr: number;
  runway_min: number;
  deficit_units: number;
}

export interface WhatIfResult {
  t: number;
  overrides: Record<string, number>;
  baseline: WhatIfForecast;
  what_if: WhatIfForecast;
}

export interface Ledger {
  total: number;
  precision_all: number | null;
  BOTTLENECK?: LedgerEntry;
  DEFECT_RISK?: LedgerEntry;
  DARK_STATION?: LedgerEntry;
  [key: string]: unknown;
}

export interface LedgerEntry {
  fired: number;
  true: number;
  false: number;
  precision: number | null;
  mean_lead_s: number | null;
  /** this shift plus every shift whose ledger state was carried in */
  lifetime_precision?: number | null;
  threshold_bump?: number;
  fire_floor?: number;
}

/** One shift, reduced to what a weekly planning review asks for. */
export interface ShiftSummary {
  shift: number;
  seed: number;
  bodies_out: number;
  constraint_sid: string | null;
  constraint_share: number | null;
  mean_rate_loss_per_hr: number | null;
  min_runway_min: number | null;
  quality_checks: number;
  quality_fails: number;
  fallout_pct: number;
  alerts_fired: number;
  precision_all: number | null;
  by_kind: Record<string, LedgerEntry>;
  built: Record<string, number>;
}

export interface HistoryData {
  shifts: number;
  horizon_s: number;
  build_mix: Record<string, number>;
  per_shift: ShiftSummary[];
  recurring_constraints: Array<{
    sid: string;
    name: string;
    shifts: number;
    share: number;
  }>;
  trend: Record<string, Array<number | null>>;
  totals: {
    bodies_out: number;
    quality_fails: number;
    alerts_fired: number;
    mean_fallout_pct: number | null;
  };
}

export interface QualityEvent {
  t: number;
  uid: string;
  inspection: string;
  result: string;
  defect_type: string | null;
  origin: string | null;
}

export interface TwinData {
  meta: {
    horizon_s: number;
    seed: number;
    n_stations: number;
    tiers: Record<string, number>;
    n_events: number;
    n_completed: number;
    n_quality_checks: number;
    n_fails: number;
    /** declared build mix, share by variant */
    build_mix?: Record<string, number>;
    /** what the shift actually built, count by variant */
    variant_counts?: Record<string, number>;
  };
  line: StationMeta[];
  zone_totals: Record<string, ZoneTotals>;
  fault_windows: FaultWindow[];
  frames: Frame[];
  alerts: Alert[];
  ledger: Ledger;
  throughput_series: [number, number][];
  quality_origin_counts: Record<string, number>;
  quality_events: QualityEvent[];
}

export interface ValidationData {
  shifts: number;
  detection: {
    recall: number;
    precision: number;
    alerts_per_shift: number;
    transient_false_alarms_total: number;
    median_detect_lag_min: number;
  };
  by_kind: Record<string, {
    true: number;
    false: number;
    precision: number;
    median_lead_min: number | null;
  }>;
  forecast: {
    twin_mae_units_per_30min: number;
    naive_mae_units_per_30min: number;
    twin_p90_units_per_30min: number;
    twin_mae_during_fault: number;
    naive_mae_during_fault: number;
    // Optional so the page still renders against a backend that predates the
    // healthy/degraded split.
    twin_mae_healthy?: number | null;
    naive_mae_healthy?: number | null;
    twin_bias_units?: number | null;
    naive_bias_units?: number | null;
    probes_during_fault?: number;
    probes_healthy?: number;
  };
  versus_spec_alarm: {
    cases: number;
    spec_alarm_never_fired_pct: number;
    median_lead_gain_min: number | null;
    median_bodies_protected: number | null;
  };
  sensor_sweep: Array<{
    scan_miss_rate: number;
    cameras: boolean;
    dark_mae_s: number;
    dark_mape_pct: number;
    bias_s: number;
  }>;
  /** mean absolute error of inferred buffer levels against ground truth, in units */
  buffer_reconstruction_mae_units: number;
  /**
   * What bounds the DEFECT_RISK precision figure. Only drifts that raised a
   * station's own fallout materially can be graded TRUE at all, so when that
   * count is small the metric is set by the test rather than the detector.
   */
  defect_risk_context?: {
    material_param_faults: number;
    defect_alerts_graded: number;
    material_recall?: number | null;
  };
  /** dark-station accuracy with and without conditioning on the build order */
  variant_conditioning?: {
    build_mix: Record<string, number>;
    dark_mae_pooled_s: number;
    dark_mae_conditioned_s: number;
    dark_mape_pooled_pct: number;
    dark_mape_conditioned_pct: number;
    per_station: Array<{
      sid: string;
      variant_spread_s: number;
      pooled_mae_s: number;
      conditioned_mae_s: number;
      gain_s: number;
    }>;
  };
  /** the precision floor loop's trajectory across the validated shifts */
  trust_loop?: {
    per_shift: Array<Record<string, unknown>>;
    final_threshold_bump: Record<string, number>;
    final_lifetime_precision: Record<string, number | null>;
  };
  /** attribution under causes that are not single-station and monotone */
  multi_causal?: {
    shifts: number;
    carry_in: {
      cases: number;
      named_true_source: number | null;
      named_symptom_station_only: number | null;
      named_nothing: number | null;
    };
    ambient: {
      cases: number;
      detected: number | null;
      mean_stations_blamed: number | null;
      mean_stations_in_zone: number | null;
    };
    intermittent: {
      cases: number;
      detected: number | null;
      median_lead_min: number | null;
    };
    operator: { cases: number; detected: number | null };
  };
}
