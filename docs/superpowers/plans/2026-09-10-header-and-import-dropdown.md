# Header Alignment and Import Dropdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push the account controls to the right of the header, and collapse two import cards into one behind a platform dropdown, so both screens spend less height on chrome.

**Architecture:** Both changes are rearrangements of existing markup. The header change moves one JSX node and adds one class. The import change wraps two existing panel bodies in a single card and renders one of them based on a new piece of state. No new components, no new dependencies, no behaviour changes to either import flow.

**Tech Stack:** React 19 + Vite, Tailwind classes inline, tested with `node --test` (unit) and Playwright (e2e).

**Spec:** `docs/superpowers/specs/2026-09-10-header-and-import-dropdown-design.md`

## Global Constraints

- **Rearrangement only.** No change to what an import does, to the Sleeper season logic, or to the Yahoo OAuth flow. If an existing assertion needs rewriting, something changed that should not have — stop and report it.
- **Every existing `data-testid` keeps its name and its behaviour.** They are the seams the suite drives.
- The email keeps `max-w-[10rem] truncate`, so a long address cannot push controls off-screen.
- An unconfigured build (no Cognito variables) must still render **nothing** where the auth controls would be — an empty right-hand side, not an empty box.
- Frontend is ESM. Never run `git stash`.
- **Screenshots are part of the deliverable.** The README displays them, and the header is on every page.

## File Structure

- `frontend/src/components/NavBar.jsx` — *modify.* Move the brand `<Link>`; add `ml-auto` to the auth block.
- `frontend/src/pages/NewDraft.jsx` — *modify.* One import card, a platform `<select>`, one new piece of state.
- `frontend/tests/yahoo.spec.js` — *modify.* Select Yahoo before reaching its button.
- `frontend/tests/newdraft.spec.js` or the existing spec that covers this page — *modify.* New dropdown tests.
- `screenshots/*.png` — *regenerate.*

---

### Task 1: The header puts the account on the right

**Files:**
- Modify: `frontend/src/components/NavBar.jsx`
- Test: the existing nav/auth specs, plus regenerated screenshots

**Interfaces:**
- Consumes: nothing.
- Produces: no code interface. `auth-controls`, `auth-user`, `sign-in`, `sign-out` and `nav-toggle` all keep their ids.

- [ ] **Step 1: Record the baseline**

Run: `cd frontend && npm run test:unit && npm test 2>&1 | tail -3`
Write both counts into the task report. Unit must be unchanged at the end; Playwright must be unchanged too — this task adds no test.

- [ ] **Step 2: Move the brand and push the account right**

In `frontend/src/components/NavBar.jsx`, the root is:

```jsx
<header className="relative flex items-center gap-3 py-4">
```

Its children are, in order: the `showAppLinks` fragment (menu toggle + nav links), the `configured ? ... : null` auth block, and last the brand `<Link to="/">`.

Cut the brand block:

```jsx
      <Link
        to="/"
        className="flex items-center gap-2 text-sm font-semibold tracking-tight text-white"
      >
        <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_20px_rgba(34,211,238,0.6)]" />
        PerfectPick
      </Link>
```

and paste it as the **first** child of `<header>`, above the `{showAppLinks && (` fragment. Reading order becomes brand → navigation → account, which is both conventional and correct for a screen reader.

Then add `ml-auto` to the auth container, which currently reads:

```jsx
        <div data-testid="auth-controls" className="flex items-center gap-2">
```

so it becomes:

```jsx
        <div data-testid="auth-controls" className="ml-auto flex items-center gap-2">
```

Do not touch the `: null` branch. An unconfigured build must still render nothing there — with no element present, nothing is pushed right, which is the correct outcome.

- [ ] **Step 3: Run the suite**

Run: `cd frontend && npm run test:unit && npm run lint && npm test 2>&1 | tail -3`
Expected: the same counts as Step 1, lint clean. **Read the printed Playwright totals, not the exit code** — this machine has produced a partial count with a zero exit.

If a test fails on position, read it before changing it: an assertion about *order* is legitimately affected by this task, but an assertion about *behaviour* failing means something broke.

- [ ] **Step 4: Check the draft page did not regain its wrap**

The draft page's own header row was fixed once for wrapping onto a third line (commit `b31dbed`), and `NavBar` sits above it on the same screen.

Run: `cd frontend && npx playwright test tests/draft.spec.js 2>&1 | tail -3`
Expected: green, including whatever assertions that spec makes about header height.

- [ ] **Step 5: Look at what changed**

Run: `git status --short screenshots/`
The full suite in Step 3 rewrote every screenshot whose page shows the header — expect several. Open at least `screenshots/home.png` and `screenshots/draft.png` and confirm with your own eyes that the account controls now sit at the right edge and nothing overlaps the brand.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/NavBar.jsx screenshots/
git commit -m "feat: the account belongs in the top right"
```

---

### Task 2: One import card, behind a platform dropdown

**Files:**
- Modify: `frontend/src/pages/NewDraft.jsx`
- Modify: `frontend/tests/yahoo.spec.js`
- Test: `frontend/tests/sleeper.spec.js` (must pass **unchanged**)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: a new `data-testid="import-platform"` on the `<select>`. Every existing id inside both panels is unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/tests/yahoo.spec.js` (or the spec covering New Draft, matching where its siblings live):

```js
test("the platform dropdown swaps which import is on screen", async ({ page }) => {
  await signIn(page);
  await page.goto("/draft/new");

  // Sleeper is the default, so its field is there without touching anything.
  await expect(page.getByTestId("sleeper-username")).toBeVisible();
  await expect(page.getByTestId("yahoo-import")).toHaveCount(0);

  await page.getByTestId("import-platform").selectOption("yahoo");
  await expect(page.getByTestId("yahoo-import")).toBeVisible();
  await expect(page.getByTestId("sleeper-username")).toHaveCount(0);

  await page.getByTestId("import-platform").selectOption("sleeper");
  await expect(page.getByTestId("sleeper-username")).toBeVisible();
});

test("a Yahoo callback lands with Yahoo already selected", async ({ page }) => {
  // Coming back from Yahoo with leagues, the dropdown must not be sitting on
  // Sleeper -- the leagues just authorised would be hidden behind it.
  await page.route(`${API}/yahoo/leagues`, (r) =>
    r.fulfill({ json: { leagues: [{ leagueName: "Money League", teams: 10, rounds: 16, format: "half-ppr", rosterSlots: ["QB", "RB"], userTeam: 4 }] } })
  );
  await page.addInitScript(([v]) => window.sessionStorage.setItem("yahoo_oauth_state", v), ["s"]);
  await signIn(page);
  await page.goto("/yahoo/callback?code=abc&state=s");

  await expect(page.getByTestId("import-platform")).toHaveValue("yahoo");
  await expect(page.getByTestId("yahoo-leagues")).toContainText("Money League");
});
```

That setup is copied from this spec's existing test "leagues carried back from the callback are listed and apply to the form", which drives the same route.

**Note what that existing test already gives you.** It asserts `yahoo-leagues` is visible after the callback — so if the dropdown defaulted to Sleeper, it would fail on its own, without the new test. Treat it as the real regression guard for the callback rule, and the new test as the explicit statement of why. If the existing one goes red during this task, the default is wrong; do not "fix" it by editing it.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd frontend && npx playwright test tests/yahoo.spec.js 2>&1 | tail -6`
Expected: both new tests FAIL because `import-platform` does not exist. Any other failure means the setup is wrong — fix that before implementing.

- [ ] **Step 3: Add the platform state**

In `frontend/src/pages/NewDraft.jsx`, beside the existing `useState` calls:

```jsx
  // Which import is on screen. Sleeper by default because it needs no login
  // -- except when we have just come back from Yahoo's callback carrying
  // leagues, in which case showing Sleeper would hide the very thing the
  // user just authorised.
  const [platform, setPlatform] = useState(
    location.state?.yahooLeagues ? "yahoo" : "sleeper"
  );
```

- [ ] **Step 4: Collapse the two cards into one**

Replace the two sibling `<div className="mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5">` panels with a single card of the same classes. Its head is the label and select, replacing both "Import from Sleeper" and "Import from Yahoo" headings:

```jsx
      <div className="mb-6 max-w-2xl rounded-3xl border border-zinc-800/70 bg-zinc-950/60 p-5">
        <div className="flex items-center gap-3">
          <label htmlFor="import-platform" className="text-sm font-semibold text-white">
            Import from
          </label>
          <select
            id="import-platform"
            data-testid="import-platform"
            value={platform}
            onChange={(e) => {
              const next = e.target.value;
              setPlatform(next);
              // Clear the other service's leagues so a set fetched from one
              // can never be applied while the other is selected. Fields the
              // import already filled in are deliberately left alone.
              if (next === "sleeper") setYahooLeagues(null);
              else setLeagues(null);
            }}
            className="rounded-2xl border border-zinc-800 bg-zinc-950/70 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-cyan-300/60"
          >
            <option value="sleeper">Sleeper</option>
            <option value="yahoo">Yahoo</option>
          </select>
        </div>

        {platform === "sleeper" ? (
          <>{/* the entire existing Sleeper body, minus its heading div */}</>
        ) : (
          <>{/* the entire existing Yahoo body, minus its heading div */}</>
        )}
      </div>
```

Move each panel's contents across **verbatim** — the blurb `<p>`, the input row, the error block, the league list, the not-configured line, the sign-in button. Drop only the two `<div className="text-sm font-semibold text-white">Import from X</div>` headings, whose job the label and select now do. Do not reword the copy.

Leave the imported-roster note where it is: it already sits outside both panels, deliberately, because either import can fill it. Its comment says so.

- [ ] **Step 5: Adjust the Yahoo spec's existing test**

`tests/yahoo.spec.js` reaches `yahoo-import` directly. Add the selection before it:

```js
  await page.getByTestId("import-platform").selectOption("yahoo");
  await page.getByTestId("yahoo-import").click();
```

Do this only where a test clicks that button. Do not touch `tests/sleeper.spec.js` — Sleeper is the default and its field is visible on load, so that spec must pass **completely unchanged**. If it does not, the default is wrong.

- [ ] **Step 6: Run everything**

Run: `cd frontend && npm run test:unit && npm run lint && npm test 2>&1 | tail -3`
Expected: all green. Confirm in the output that `sleeper.spec.js` passed with no edits.

- [ ] **Step 7: Look at the page**

Run: `git status --short screenshots/` — `newdraft.png` must be among the changes.

Open it. Confirm: one card, the dropdown reading "Sleeper", the username row beneath it, and Teams/Rounds visibly higher up the page than before. If Teams and Rounds have not moved up, the cards did not actually collapse.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/pages/NewDraft.jsx frontend/tests/yahoo.spec.js screenshots/
git commit -m "feat: choose the import platform from a dropdown"
```

---

### Task 3: Ship it

**Files:** none. This is the gate.

- [ ] **Step 1: Full verification**

```bash
cd frontend && npm run test:unit && npm run lint && npm test
cd ../backend && node --test 'src/**/*.test.js'
```

Expected: unit and Playwright green with counts read from the printed totals, lint clean, backend unchanged — this work touches no backend file, so a changed backend count means something is wrong.

- [ ] **Step 2: Confirm the screenshots are all committed**

Run: `git status --short`
Expected: clean. A screenshot left uncommitted means the README shows the old layout.

- [ ] **Step 3: Deploy the frontend**

Backend is untouched, so there is no `sam deploy` in this release.

```bash
cd frontend && npm run deploy
```

Then wait for the CloudFront invalidation to report `Completed`, and confirm the live `index.html` references the bundle just built:

```bash
curl -s https://d2kf4b52rvabfv.cloudfront.net/index.html | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
ls dist/assets/*.js
```
The two must name the same file.

- [ ] **Step 4: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill.
