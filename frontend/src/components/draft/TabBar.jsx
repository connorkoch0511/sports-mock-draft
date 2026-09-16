// Tabs are destinations, not actions -- the strip holds state and the overflow
// sheet holds controls. That division is what keeps a fourth tab (Queue)
// an addition rather than a reflow: grid-cols-3 becomes grid-cols-4 and a row
// joins TABS.
const TABS = [
  // Short labels, because four of them share 390px. "Draft Board" and "Team
  // Rosters" each wrapped to two lines the moment Queue landed -- which the
  // review of the tab bar predicted when there were three. The panels keep
  // their full headings; a bottom nav is a place you tap, not a place you
  // read, and every label here is unambiguous on its own.
  { id: "board", label: "Board", testid: "tab-board" },
  { id: "draft", label: "Draft", testid: "tab-draft" },
  { id: "rosters", label: "Rosters", testid: "tab-rosters" },
  { id: "queue", label: "Queue", testid: "tab-queue" },
];

export default function TabBar({ active, onChange }) {
  return (
    <nav
      data-testid="tab-bar"
      aria-label="Draft views"
      // sticky, not static: below 35rem of height the page is allowed to
      // scroll (see index.css), and a tab bar that scrolls away with the
      // content is a tab bar you have to scroll 3,000px to reach. Above
      // that threshold the page does not scroll at all, so this is inert
      // there rather than a second layout to keep working.
      className="xl:hidden sticky bottom-0 z-20 shrink-0 grid grid-cols-4 gap-1 rounded-2xl border border-zinc-800/70 bg-zinc-950/95 p-1 backdrop-blur"
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
