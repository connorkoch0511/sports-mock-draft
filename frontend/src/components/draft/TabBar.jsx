// Tabs are destinations, not actions -- the strip holds state and the overflow
// sheet holds controls. That division is what keeps a fourth tab (Queue)
// an addition rather than a reflow: grid-cols-3 becomes grid-cols-4 and a row
// joins TABS.
const TABS = [
  { id: "board", label: "Big Board", testid: "tab-board" },
  { id: "draft", label: "Draft Board", testid: "tab-draft" },
  { id: "rosters", label: "Team Rosters", testid: "tab-rosters" },
  { id: "queue", label: "Queue", testid: "tab-queue" },
];

export default function TabBar({ active, onChange }) {
  return (
    <nav
      data-testid="tab-bar"
      aria-label="Draft views"
      className="lg:hidden shrink-0 grid grid-cols-4 gap-1 rounded-2xl border border-zinc-800/70 bg-zinc-950/80 p-1 backdrop-blur"
    >
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          data-testid={t.testid}
          aria-current={active === t.id ? "page" : undefined}
          onClick={() => onChange(t.id)}
          className={`rounded-xl px-2 py-2.5 text-xs transition-colors ${
            active === t.id
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}
