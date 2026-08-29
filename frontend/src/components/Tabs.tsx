type View = "floor" | "manager" | "leadership";

const TABS: { id: View; label: string }[] = [
  { id: "floor", label: "Floor Supervisor" },
  { id: "manager", label: "Plant Manager" },
  { id: "leadership", label: "Leadership" },
];

export function Tabs({
  active,
  onChange,
}: {
  active: View;
  onChange: (v: View) => void;
}) {
  return (
    <nav className="tabs">
      {TABS.map((t) => (
        <button
          key={t.id}
          className={active === t.id ? "active" : ""}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
