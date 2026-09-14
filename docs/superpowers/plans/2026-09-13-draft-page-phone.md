# Draft Page on a Phone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The draft page fits one phone screen, with three tabs, a pinned status strip, and the setup controls in a sheet — while the desktop layout is byte-identical.

**Architecture:** Everything phone-only is expressed with Tailwind's `max-lg:` variant (Tailwind 4.1.18), so no existing desktop class is touched. Panels stay mounted and are hidden with `display: none`, which **preserves `scrollTop`** — verified empirically, and the opposite of the intuitive assumption. Each panel is wrapped in a `lg:contents` div so that at `lg` and above the wrapper vanishes from the box tree and the panels remain direct grid children, keeping `RosterPanel`'s own `lg:col-span-2 xl:col-span-1` working.

**Tech Stack:** React 19, Tailwind 4, Playwright (Chromium only, default viewport 1280×720).

**Spec:** `docs/superpowers/specs/2026-09-13-draft-page-phone-design.md`

## Corrections

**This plan's code blocks were wrong five times.** They are left as written so
the record is honest, but do not copy them — read the shipped files. Every
defect below reached a green test suite before something else caught it.

1. **`pane()` was `max-lg:flex`** (row direction), so width was the main axis
   and panels sized to content: Team Rosters rendered at 171px inside a 334px
   wrapper. Caught by rendering the page, not by tests. Shipped version adds
   `flex-col` and `[&>*]:flex-1`.
2. **`pane()` had `min-h-0` but no `min-w-0`.** A grid item defaults to
   `min-width: auto`, so the Draft Board inflated to 656px in a 390px viewport
   with ~266px clipped and unreachable. The test written for defect 1 passed
   on this — both numbers were 656.
3. **Task 2 Step 5 hid the header with `max-lg:hidden` and nothing else, and
   Step 3's `ControlSheet` had no focus handling.** A `display: none` element
   still matches Playwright locators, so the strip's text made two
   *pre-existing* unscoped `getByText` assertions ambiguous. The shipped
   version gates the phone chrome **and** the desktop header on `useIsPhone()`
   so each is absent from the other's DOM. Task 2's note about duplicate
   testids needing scoped assertions is therefore obsolete.
4. **`ControlSheet`'s focus effect depended on `onClose`**, an inline arrow
   recreated every render, while a live draft re-renders once a second from
   the countdown tick — so it restored and re-stole focus every second, making
   the sheet's own controls unusable. Its test passed *because* of the bug.
   Shipped version splits the effects, as `PlayerModal` already did.
5. **The plan's central premise was false.** It states the suite runs at
   1280×720 so every existing test exercises desktop. `tests/draftlayout.spec.js`
   already ran at 390×844, 768×1024 and 1024×768, and was never part of the
   "desktop net" this plan named. Its shared helper asserted `panel-rosters`
   visible, which tabs make false below `lg`. Editing it was correct — the rule
   protects *desktop*, and those two run at phone and tablet widths where the
   design deliberately changed — but the plan should have known the file
   existed.

The lesson the branch actually taught: **code and tests both looked right while
the rendered page was wrong**, repeatedly. Render the page and measure real
geometry; a diff review cannot see this class of defect, and a test can be
written that passes because of it.

## Global Constraints

- **The desktop layout must not change.** The suite runs at 1280×720, above the 1024px `lg` breakpoint, so every existing draft test exercises desktop. **If any existing test needs editing, STOP and report** — that means desktop moved, which the design forbids. This includes the two header no-wrap tests in `boarddraft.spec.js`.
- Phone styling uses `max-lg:` only. Do not modify or remove an existing class to make room for one.
- Panels stay mounted. Hiding is `display: none` via `max-lg:hidden`. **Do not** switch to conditional rendering, and do not substitute `visibility: hidden` or absolute positioning — both lose scroll position (measured: `display:none` keeps `scrollTop` at 500; visibility/absolute resets it to 0).
- Tab tests assert **visibility**, never `toHaveCount(0)`. This is the deliberate opposite of the completed-draft header rule, and the spec says why.
- Tab labels are exactly `Big Board`, `Draft Board`, `Team Rosters` — the panels' existing headings.
- The tab bar is laid out for four. A Queue tab is a later project; leave room, build nothing for it.
- Playwright on this machine truncates when the laptop sleeps. The controller owns the full-suite run (`caffeinate -i npm test`, total compared with `npx playwright test --list`). Implementers run only the focused `-g` commands named below.
- **Never edit the working tree while a suite is running** — Vite hot-reloads underneath it and the run hangs.

---

### Task 1: Three tabs, and a page that fits its screen

**Files:**
- Create: `frontend/src/components/draft/TabBar.jsx`
- Modify: `frontend/src/pages/Draft.jsx` (page root ~line 441, content div ~449, grid ~682, panel children ~683-697)
- Test: `frontend/tests/draftphone.spec.js` (new file)

**Interfaces:**
- Produces: `tab` state (`"board" | "draft" | "rosters"`) and `setTab`, which Task 3 reads to jump to Big Board. `TabBar` takes `{ active, onChange }`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/tests/draftphone.spec.js`:

```js
import { test, expect } from "@playwright/test";
import { DRAFT_ID, makeDraftState, mockDraftApis } from "./fixtures.js";
import { signIn } from "./auth.js";

// Everything phone-shaped lives in this file so the rest of the suite keeps
// running at the desktop viewport that is the design's regression net.
test.describe("the draft page on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  async function openDraft(page) {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();
  }

  const scroller = (page) =>
    page.evaluate(() => {
      const el = document.querySelector('[class*="overflow-y-auto"]');
      return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });

  // The measurement that opened the spec, inverted into an assertion: this
  // page was 6,333px against a 776px screen, 8.2 screens of scrolling.
  test("the page fits its screen instead of running 8 screens deep", async ({ page }) => {
    await openDraft(page);
    const { scrollHeight, clientHeight } = await scroller(page);
    expect(scrollHeight).toBeLessThanOrEqual(clientHeight + 8);
  });

  test("each tab shows its own panel and hides the others", async ({ page }) => {
    await openDraft(page);

    await expect(page.getByTestId("panel-big-board")).toBeVisible();
    await expect(page.getByTestId("panel-draft-board")).toBeHidden();
    await expect(page.getByTestId("panel-rosters")).toBeHidden();

    await page.getByTestId("tab-draft").click();
    await expect(page.getByTestId("panel-draft-board")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await expect(page.getByTestId("panel-draft-board")).toBeHidden();
  });

  // Panels stay mounted precisely so this holds. A "simplification" to
  // conditional rendering, or to visibility/absolute positioning, fails here:
  // both reset scrollTop, while display:none preserves it.
  test("leaving a tab and coming back keeps your place in it", async ({ page }) => {
    await openDraft(page);

    const list = page.getByTestId("scroll-big-board");
    await list.evaluate((el) => { el.scrollTop = 300; });
    const before = await list.evaluate((el) => el.scrollTop);
    expect(before).toBeGreaterThan(0);

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await page.getByTestId("tab-board").click();
    await expect(page.getByTestId("panel-big-board")).toBeVisible();

    expect(await list.evaluate((el) => el.scrollTop)).toBe(before);
  });
});

// The other half of the contract: none of this exists on a desktop.
test("no tab bar at desktop width", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("tab-bar")).toBeHidden();
  await expect(page.getByTestId("panel-draft-board")).toBeVisible();
  await expect(page.getByTestId("panel-rosters")).toBeVisible();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js
```

Expected: the three phone tests FAIL (no `tab-bar` exists, so `openDraft` times out); `no tab bar at desktop width` FAILS too, because `getByTestId("tab-bar")` resolves to nothing and `toBeHidden()` on a missing element passes — check the output: it should pass for the right reason once the bar exists. If it passes now, that is fine and expected; it becomes meaningful in Step 6.

- [ ] **Step 3: Create the tab bar**

Create `frontend/src/components/draft/TabBar.jsx`:

```jsx
// Tabs are destinations, not actions -- the strip holds state and the overflow
// sheet holds controls. That division is what keeps a fourth tab (Queue) an
// addition rather than a reflow: grid-cols-3 becomes grid-cols-4 and a row
// joins TABS.
const TABS = [
  { id: "board", label: "Big Board", testid: "tab-board" },
  { id: "draft", label: "Draft Board", testid: "tab-draft" },
  { id: "rosters", label: "Team Rosters", testid: "tab-rosters" },
];

export default function TabBar({ active, onChange }) {
  return (
    <nav
      data-testid="tab-bar"
      aria-label="Draft views"
      className="lg:hidden shrink-0 grid grid-cols-3 gap-1 rounded-2xl border border-zinc-800/70 bg-zinc-950/80 p-1 backdrop-blur"
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
```

- [ ] **Step 4: Wire it into the draft page**

In `frontend/src/pages/Draft.jsx`:

Import it beside the other draft components:

```jsx
import TabBar from "../components/draft/TabBar";
```

Add the state beside the other `useState` calls near the top of the component:

```jsx
  const [tab, setTab] = useState("board");
```

Make the page fill exactly one screen below `lg`. The root currently reads:

```jsx
    <div className="relative min-h-full xl:h-full w-full overflow-x-hidden">
```

becomes:

```jsx
    <div className="relative min-h-full max-lg:h-full xl:h-full w-full overflow-x-hidden">
```

and the content div:

```jsx
      <div className="relative mx-auto max-w-7xl px-6 py-6 min-h-full xl:h-full flex flex-col gap-4">
```

becomes:

```jsx
      <div className="relative mx-auto max-w-7xl px-6 py-6 min-h-full max-lg:h-full max-lg:px-3 max-lg:py-3 xl:h-full flex flex-col gap-4">
```

- [ ] **Step 5: Wrap the panels and add the bar**

Add the helper just above the `return`:

```jsx
  // `lg:contents` makes the wrapper vanish from the box tree at desktop, so the
  // panels stay direct grid children and RosterPanel's own lg:col-span-2 still
  // applies. Below lg the wrapper is the visibility switch -- display:none,
  // which preserves scrollTop (measured), where visibility/absolute does not.
  const pane = (id) =>
    `lg:contents ${tab === id ? "max-lg:flex max-lg:min-h-0 max-lg:flex-1" : "max-lg:hidden"}`;
```

Then replace the grid's children:

```jsx
        <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[420px_minmax(0,1fr)_360px] flex-1 min-h-0 min-w-0">
            <div className={pane("board")}>
              <BigBoardPanel
                draft={draft}
                players={players}
                boardRows={boardRows}
                boardMeta={boardMeta}
                boardFailed={boardFailed}
                myTeam={myTeam}
                isMyTurn={isMyTurn}
                paused={paused}
                canManualPick={canManualPick}
                makePick={makePick}
              />
            </div>

            <div className={pane("draft")}>
              <DraftBoardPanel draft={draft} playersById={playersById} />
            </div>

            <div className={pane("rosters")}>
              <RosterPanel draft={draft} />
            </div>
        </div>

        <TabBar active={tab} onChange={setTab} />
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js
```

Expected: 4 passed.

If `the page fits its screen` still fails, report the measured numbers rather than adding heights to force it — it means a panel is not scrolling internally, and the fix belongs in the plan, not in a magic number.

- [ ] **Step 7: Prove the desktop layout did not move**

```bash
cd frontend && npx playwright test tests/draft.spec.js tests/boarddraft.spec.js
```

Expected: all pass, **with no edits to any of them**. If one needs editing, STOP and report.

- [ ] **Step 8: Prove the mounted-panel requirement is load-bearing**

Temporarily change `pane` so the inactive panels are not rendered at all — replace the wrapper's `max-lg:hidden` branch with returning `null` for inactive panes — and confirm `leaving a tab and coming back keeps your place in it` fails. Restore.

Expected: conditional rendering → that test fails; restored → 4 passed.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/draft/TabBar.jsx frontend/src/pages/Draft.jsx frontend/tests/draftphone.spec.js
git commit -m "feat: tabs put the draft page on one phone screen"
```

---

### Task 2: The status strip and the overflow sheet

The header wraps into five rows on a phone. Below `lg` it is replaced by a strip carrying state plus Pause, with the five setup controls moved into a bottom sheet. Above `lg` the header renders exactly as it does today.

**Files:**
- Create: `frontend/src/components/draft/StatusStrip.jsx`, `frontend/src/components/draft/ControlSheet.jsx`
- Modify: `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draftphone.spec.js`

**Interfaces:**
- Consumes: Task 1's `tab`/`setTab` and `TabBar`.
- Produces: `StatusStrip` takes `{ statusLabel, myTeam, paused, busy, completed, onTogglePause, onOpenSheet }`; `ControlSheet` takes `{ open, onClose, children }`. Task 3 adds `isMyTurn` and `onTap` to `StatusStrip` — do not add them here.

**Duplicate testids are deliberate and must stay scoped.** The five controls exist twice once the sheet is open: the desktop header's copies (hidden by `max-lg:hidden`) and the sheet's. `ControlSheet` returns `null` when closed, so a closed sheet leaves exactly one copy and existing desktop tests are unaffected. Any assertion made while the sheet is open must be scoped — `sheet.getByTestId(...)` — or it is a strict-mode violation.

- [ ] **Step 1: Write the failing tests**

Append inside the existing `test.describe("the draft page on a phone", ...)` block in `frontend/tests/draftphone.spec.js`:

```js
  test("the strip is on every tab, and carries Pause", async ({ page }) => {
    await openDraft(page);

    for (const t of ["tab-board", "tab-draft", "tab-rosters"]) {
      await page.getByTestId(t).click();
      await expect(page.getByTestId("status-strip")).toBeVisible();
      await expect(
        page.getByTestId("status-strip").getByRole("button", { name: /Pause|Resume/ })
      ).toBeVisible();
    }
  });

  // Five wrapped rows of controls was half of what made this page unusable.
  // These are all set-once -- which board drives your auto-pick, whether to
  // notify, who to invite -- so they belong behind the sheet, not in the way.
  test("the setup controls are in the sheet, not the strip", async ({ page }) => {
    await openDraft(page);

    // Closed, the only copies in the DOM are the desktop header's, hidden by
    // max-lg:hidden -- one match each, so these are unambiguous.
    const ids = ["seat-board", "copy-invite", "notify-toggle"];
    for (const id of ids) await expect(page.getByTestId(id)).toBeHidden();
    await expect(page.getByRole("button", { name: "Auto Pick" })).toBeHidden();

    await page.getByTestId("open-controls").click();
    const sheet = page.getByTestId("control-sheet");
    await expect(sheet).toBeVisible();

    // Scoped to the sheet on purpose. With it open there are TWO elements for
    // each testid -- the header's hidden copy and the sheet's -- and an
    // unscoped getByTestId would be a strict-mode violation, not a pass.
    for (const id of ids) await expect(sheet.getByTestId(id)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Auto Pick" })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Sim to End" })).toBeVisible();

    await page.getByTestId("close-controls").click();
    await expect(page.getByTestId("control-sheet")).toBeHidden();
  });
```

And beside the existing desktop test, at file scope:

```js
test("no strip or sheet button at desktop width", async ({ page }) => {
  const state = makeDraftState({ currentIndex: 0 });
  mockDraftApis(page, state);
  await signIn(page);
  await page.goto(`/draft/${DRAFT_ID}`);
  await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
  await expect(page.getByTestId("status-strip")).toBeHidden();
  await expect(page.getByTestId("open-controls")).toBeHidden();
  // The desktop header still has its own controls, in place.
  await expect(page.getByTestId("seat-board")).toBeVisible();
  await expect(page.getByTestId("copy-invite")).toBeVisible();
});
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js -g "the strip is on every tab|the setup controls are in the sheet"
```

Expected: 2 failed — no `status-strip` exists.

- [ ] **Step 3: Create the sheet**

Create `frontend/src/components/draft/ControlSheet.jsx`:

```jsx
// A sheet rather than a dropdown: it rises near the thumb and gives each row a
// real touch target, where a menu dropping from the top of a tall phone is a
// mis-tap generator.
export default function ControlSheet({ open, onClose, children }) {
  if (!open) return null;
  return (
    <div className="lg:hidden fixed inset-0 z-40 flex flex-col justify-end">
      <button
        type="button"
        aria-label="Close controls"
        data-testid="close-controls"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        data-testid="control-sheet"
        role="dialog"
        aria-label="Draft controls"
        className="relative rounded-t-3xl border-t border-zinc-800 bg-zinc-950 p-4 pb-8 flex flex-col gap-3"
      >
        <div className="mx-auto h-1 w-10 rounded-full bg-zinc-700" />
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create the strip**

Create `frontend/src/components/draft/StatusStrip.jsx`:

```jsx
// What is true right now, and the one control you reach for in a hurry. The
// clock cannot be a tap away, which is why every draft app pins it.
export default function StatusStrip({
  statusLabel,
  myTeam,
  paused,
  busy,
  completed,
  onTogglePause,
  onOpenSheet,
}) {
  return (
    <div
      data-testid="status-strip"
      className="lg:hidden shrink-0 flex items-center gap-2 rounded-2xl border border-zinc-800/70 bg-zinc-950/80 px-3 py-2 backdrop-blur"
    >
      <span data-testid="strip-status" className="text-sm text-zinc-100">
        {statusLabel}
      </span>
      <span className="ml-auto text-xs text-zinc-400">Team {myTeam}</span>
      {!completed && (
        <button
          type="button"
          onClick={onTogglePause}
          disabled={busy}
          className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200 disabled:opacity-50"
        >
          {paused ? "Resume" : "Pause"}
        </button>
      )}
      <button
        type="button"
        data-testid="open-controls"
        onClick={onOpenSheet}
        aria-label="Draft controls"
        className="rounded-xl border border-zinc-800 px-3 py-1.5 text-xs text-zinc-200"
      >
        ⋯
      </button>
    </div>
  );
}
```

- [ ] **Step 5: Hide the desktop header below `lg` and render the strip**

In `Draft.jsx`, import both components, add `const [sheetOpen, setSheetOpen] = useState(false);` beside the other state, and give the existing top-bar div a phone-only hide. The top bar currently opens:

```jsx
        <div className="rounded-3xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
```

becomes:

```jsx
        <div className="max-lg:hidden rounded-3xl border border-zinc-800/70 bg-zinc-950/60 px-3 py-4 backdrop-blur shadow-[0_0_0_1px_rgba(255,255,255,0.02)]">
```

Immediately after that top-bar div closes, add the strip and the sheet:

```jsx
        <StatusStrip
          statusLabel={statusLabel}
          myTeam={myTeam}
          paused={paused}
          busy={busy}
          completed={completed}
          onTogglePause={togglePause}
          onOpenSheet={() => setSheetOpen(true)}
        />

        <ControlSheet open={sheetOpen} onClose={() => setSheetOpen(false)}>
          {/* The same five controls the desktop header carries. They are
              rendered a second time rather than moved, so each presentation
              stays simple; the state and handlers behind them are shared. */}
        </ControlSheet>
```

- [ ] **Step 6: Derive the strip's label**

The strip needs one line describing the current state. Add beside the other derived values, above the `return`:

```jsx
  // The pill ternary in the desktop header answers the same question across
  // five branches; the strip needs one string, in the same order of
  // precedence: finished, then stopped, then yours, then whose.
  const statusLabel = completed
    ? "✅ Completed"
    : paused
      ? "⏸ Paused"
      : isMyTurn
        ? `⏱ ${formatCountdown(secondsLeft)} · your pick`
        : onClockIsBot
          ? "Auto-picking…"
          : `Waiting on Team ${currentTeamOnClock}`;
```

- [ ] **Step 7: Move the five controls into the sheet**

Copy the five controls from the desktop header into `ControlSheet`'s children, unchanged apart from full-width layout classes: the `seat-board` select (with its `Auto-pick from` label now visible, since the sheet has room), `Auto Pick`, `Sim to End`, `copy-invite`, `notify-toggle`. Keep every `data-testid`, handler and `disabled` expression exactly as the header has them.

Each row: `className="w-full rounded-xl border border-zinc-800 px-3 py-3 text-sm text-zinc-200 text-left disabled:opacity-50"`.

The header keeps its own copies; they are hidden below `lg` along with the whole top bar.

- [ ] **Step 8: Run the tests**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js
```

Expected: all pass.

- [ ] **Step 9: Desktop regression net**

```bash
cd frontend && npx playwright test tests/draft.spec.js tests/boarddraft.spec.js
```

Expected: all pass with no edits. STOP and report if any needs editing — note especially that the header tests select controls by testid, and there are now two copies of each in the DOM. **If a desktop test fails because a selector became ambiguous, that is a real finding: report it rather than adding `.first()`.**

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/draft frontend/src/pages/Draft.jsx frontend/tests/draftphone.spec.js
git commit -m "feat: a status strip and a control sheet replace the header on a phone"
```

---

### Task 3: Your turn, and how you get to it

**Files:**
- Modify: `frontend/src/components/draft/StatusStrip.jsx`, `frontend/src/pages/Draft.jsx`
- Test: `frontend/tests/draftphone.spec.js`

**Interfaces:**
- Consumes: Task 1's `setTab`, Task 2's `StatusStrip`.

- [ ] **Step 1: Write the failing tests**

Append inside the phone `describe`:

```js
  // ESPN's clock turns gold when you are up. The strip has to say "you" in a
  // way that survives being glanced at, and it has to be the shortest route
  // to the board -- the notification-to-pick path is one tap.
  test("your turn is visible in the strip, and tapping it goes to the board", async ({ page }) => {
    await openDraft(page);
    await expect(page.getByTestId("strip-status")).toContainText("your pick");
    await expect(page.getByTestId("status-strip")).toHaveAttribute("data-your-turn", "true");

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();

    await page.getByTestId("strip-status").click();
    await expect(page.getByTestId("panel-big-board")).toBeVisible();
  });

  // The opposite of helpful: moving somebody's view while they are reading.
  // The strip and the push notification already tell them.
  test("the turn changing does not move you off the tab you are on", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 1 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();

    await page.getByTestId("tab-rosters").click();
    await expect(page.getByTestId("panel-rosters")).toBeVisible();

    // Advance the draft under the page the way the 3s poll would see it.
    state.currentIndex = 0;
    await page.waitForTimeout(4000);

    await expect(page.getByTestId("strip-status")).toContainText("your pick");
    await expect(page.getByTestId("panel-rosters")).toBeVisible();
    await expect(page.getByTestId("panel-big-board")).toBeHidden();
  });
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js -g "your turn is visible in the strip|the turn changing does not move you"
```

Expected: the first fails on the missing `data-your-turn` attribute. The second may already pass — nothing switches tabs yet — which is correct and expected: it exists to stop anyone adding auto-switching later.

- [ ] **Step 3: Give the strip a turn state and make it tappable**

In `StatusStrip.jsx`, add `isMyTurn` and `onTap` to the props, put the attribute on the container, and make the status a button:

```jsx
    <div
      data-testid="status-strip"
      data-your-turn={isMyTurn ? "true" : "false"}
      className={`lg:hidden shrink-0 flex items-center gap-2 rounded-2xl border px-3 py-2 backdrop-blur ${
        isMyTurn
          ? "border-cyan-300/60 bg-cyan-300/10"
          : "border-zinc-800/70 bg-zinc-950/80"
      }`}
    >
      <button
        type="button"
        data-testid="strip-status"
        onClick={onTap}
        className={`text-left text-sm ${isMyTurn ? "text-cyan-200 font-semibold" : "text-zinc-100"}`}
      >
        {statusLabel}
      </button>
```

The rest of the component is unchanged.

- [ ] **Step 4: Pass the new props**

In `Draft.jsx`, add to the `<StatusStrip ... />` call:

```jsx
          isMyTurn={isMyTurn}
          onTap={() => setTab("board")}
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npx playwright test tests/draftphone.spec.js
```

Expected: all pass.

- [ ] **Step 6: Prove the no-auto-switch test can fail**

Temporarily add `useEffect(() => { if (isMyTurn) setTab("board"); }, [isMyTurn]);` to `Draft.jsx` and confirm `the turn changing does not move you off the tab you are on` fails. Remove it.

Expected: with the effect → that test fails; without → all pass.

- [ ] **Step 7: Add a phone screenshot**

No screenshot shows any mobile layout. Append at file scope in `draftphone.spec.js`:

```js
test.describe("phone screenshot", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("draft page on a phone", async ({ page }) => {
    const state = makeDraftState({ currentIndex: 0 });
    mockDraftApis(page, state);
    await signIn(page);
    await page.goto(`/draft/${DRAFT_ID}`);
    await expect(page.getByTestId("tab-bar")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Big Board" })).toBeVisible();
    await page.screenshot({ path: `${SCREENSHOTS}/draft-phone.png` });
  });
});
```

with the imports that need adding at the top of the file:

```js
import { fileURLToPath } from "url";
import path from "path";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = path.resolve(__dirname, "../../screenshots");
```

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/draft/StatusStrip.jsx frontend/src/pages/Draft.jsx frontend/tests/draftphone.spec.js screenshots/draft-phone.png
git commit -m "feat: the strip says when it is your turn, and takes you there"
```

---

## After all three tasks

The controller runs the full suite under `caffeinate`, compares the printed total with `npx playwright test --list`, and checks which screenshots changed. `draft-phone.png` is new and expected; **any other screenshot changing is a finding**, since desktop is supposed to be untouched.

Add the README a line pointing at `screenshots/draft-phone.png` if it lists the others.
