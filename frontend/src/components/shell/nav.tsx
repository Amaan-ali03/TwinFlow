import type { ReactNode } from "react";

export type RoleId = "floor" | "manager" | "leadership";

export interface NavItem {
  label: string;
  to: string;
  icon: ReactNode;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

export const ROLE_LABEL: Record<RoleId, string> = {
  floor: "Floor Supervisor",
  manager: "Plant Manager",
  leadership: "Leadership",
};

/* ---------- icons — 18px, inherit currentColor, no fill ---------- */
const iconProps = {
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const I = {
  gauge: (
    <svg {...iconProps}>
      <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
      <path d="m13.4 12.6 3.6-3.6" />
      <path d="M4.5 18a9 9 0 1 1 15 0" />
    </svg>
  ),
  activity: (
    <svg {...iconProps}>
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  ),
  bell: (
    <svg {...iconProps}>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  ),
  funnel: (
    <svg {...iconProps}>
      <path d="M3 4h18l-7 8v7l-4 2v-9L3 4Z" />
    </svg>
  ),
  crosshair: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </svg>
  ),
  clock: (
    <svg {...iconProps}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  layers: (
    <svg {...iconProps}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  ),
  chip: (
    <svg {...iconProps}>
      <rect x="7" y="7" width="10" height="10" rx="1.5" />
      <path d="M9 3v2M15 3v2M9 19v2M15 19v2M3 9h2M3 15h2M19 9h2M19 15h2" />
    </svg>
  ),
  shield: (
    <svg {...iconProps}>
      <path d="M12 3 4 6v6c0 5 3.5 7.5 8 9 4.5-1.5 8-4 8-9V6l-8-3Z" />
    </svg>
  ),
  trending: (
    <svg {...iconProps}>
      <path d="M3 17 9 11l4 4 8-8" />
      <path d="M17 4h4v4" />
    </svg>
  ),
  briefcase: (
    <svg {...iconProps}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 12h18" />
    </svg>
  ),
  warning: (
    <svg {...iconProps}>
      <path d="M12 4 2.5 20h19L12 4Z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  ),
  route: (
    <svg {...iconProps}>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18H14a3.5 3.5 0 0 0 0-7H10a3.5 3.5 0 0 1 0-7h5.5" />
    </svg>
  ),
};

export const NAV: Record<RoleId, NavGroup[]> = {
  floor: [
    {
      heading: "Monitor",
      items: [
        { label: "Overview", to: "/floor/overview", icon: I.gauge },
        { label: "Live Line", to: "/floor/live-line", icon: I.activity },
        { label: "Alerts", to: "/floor/alerts", icon: I.bell },
        { label: "Bottlenecks", to: "/floor/bottlenecks", icon: I.funnel },
      ],
    },
    {
      heading: "Inspect",
      items: [
        { label: "Station Detail", to: "/floor/station", icon: I.crosshair },
      ],
    },
  ],
  manager: [
    {
      heading: "Overview",
      items: [
        { label: "Overview", to: "/manager/overview", icon: I.gauge },
        { label: "Live Performance", to: "/manager/live-performance", icon: I.activity },
      ],
    },
    {
      heading: "Analysis",
      items: [
        { label: "Alerts", to: "/manager/alerts", icon: I.bell },
        { label: "Bottlenecks", to: "/manager/bottlenecks", icon: I.funnel },
        { label: "Quality", to: "/manager/quality", icon: I.layers },
        { label: "Diagnostics", to: "/manager/diagnostics", icon: I.chip },
      ],
    },
    {
      heading: "Planning",
      items: [
        { label: "Shift History", to: "/manager/history", icon: I.clock },
      ],
    },
  ],
  leadership: [
    {
      heading: "Executive",
      items: [
        { label: "Executive Overview", to: "/leadership/overview", icon: I.gauge },
      ],
    },
    {
      heading: "Evidence",
      items: [
        { label: "Model Performance", to: "/leadership/model-performance", icon: I.trending },
        { label: "Reliability", to: "/leadership/reliability", icon: I.shield },
        { label: "Root Cause", to: "/leadership/root-cause", icon: I.route },
      ],
    },
    {
      heading: "Business",
      items: [
        { label: "Business Case", to: "/leadership/business-case", icon: I.briefcase },
        { label: "Risks & Mitigations", to: "/leadership/risks", icon: I.warning },
      ],
    },
  ],
};
