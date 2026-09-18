# Plan: two lies the drill-down tells on a phone

Spec: `docs/superpowers/specs/2026-09-17-drilldown-phone-truth-design.md`
Branch: `fix/drilldown-phone-truth`

Two independent defects in one file, `frontend/src/components/draft/PlayerDetail.jsx`.
They are ordered so the cheaper one lands first and the screenshot is
regenerated once, at the end, against both.

Every task is test-first, and **every new test must be seen to fail against
current `master` behaviour before the fix is written.** A test that passes
before the fix exists is measuring something else — this repo's record has five
of those.

---

## Task 1 — the KPI row stops claiming "absent" when it means "not yet"

**Test first.** Add to `frontend/tests/player.spec.js`, beside the existing
em-dash test at :220 (which must stay green untouched):

- A route handler that delays ~1200ms before fulfilling, then
  `goto('/player/9221?format=ppr', { waitUntil: 'commit' })`.
- Wait for `player-kpis`, then assert all three of `kpi-fpts`, `kpi-posrank`,
  `kpi-snapshare` do **not** contain `—`.
- Then assert they resolve to `22.6`, `1`, `63%` after the fetch lands, so the
  test cannot pass by the row never rendering.

Run it. **Expected: red**, because today all three read `—` during the fetch.
Record the failure text.

**Then implement.** In `PlayerDetail.jsx`:

    const loading = !detail && !failed;

`loading` derives from state that already exists — the same expression line 294
uses for the game log's "Loading…". Pass a placeholder through the three `Stat`
values when it holds; keep `—` for the loaded-and-absent case. `computeKpis` is
not touched.

Placeholder: `·` (a middle dot). It makes no claim, is visibly not an em dash,
and occupies one character so the row's geometry does not move. If it reads
poorly in the render, `…` is the fallback — decided by looking, not by argument.

**Verify:**
1. New test green.
2. `player.spec.js:220` still green — the loaded-and-absent em dash survives.
3. **Mutation check:** delete the `loading` branch. The new test must go red.
   Restore.

---

## Task 2 — the columns worth reading stop being the hidden ones

**Test first.** Add to `player.spec.js`, at 390x844 on the Game Log tab:

- Read the wrapper's `getBoundingClientRect().right` and the `right` of the
  `SNP` and `PTS` header cells.
- Assert both header rights are `<=` the wrapper's right.
- Assert the table still has 10 columns for an RB, so the test cannot pass by
  columns having been dropped instead of reordered.

Run it. **Expected: red** — measured today, `PTS` sits 126px and `SNP` 84px past
that edge.

**Then implement.** In `PlayerDetail.jsx`, move `SNP` and `PTS` from last to
immediately after `WK`, in both the `<thead>` row and the played-week `<tr>`, so
header and body stay in lockstep. The `cols.map` block follows them.

Two things to keep intact while moving cells:

- The gap row's `colSpan={cols.length + 2}` still spans every column after `WK`.
  The `+2` is `SNP` and `PTS`; reordering does not change the count, but the
  gap row must still be checked in the render.
- `statValue(row, "pts_ppr").toFixed(1)` and the `share == null ? "—" : …`
  read stay exactly as they are. That `—` is a *different* em dash from Task 1's
  and is correct: it means the snap data for that week is unknown.

**Verify:**
1. New geometry test green.
2. The whole drill-down and player suites green — `drilldown.spec.js` and
   `player.spec.js` both assert on this table's contents (weeks, gaps, zeroes,
   per-position columns), and column order must not have broken any of them.
3. **Mutation check:** restore the old column order. The geometry test must go
   red. Restore the fix.

---

## Task 3 — render it, then the screenshot

The spec's numbers came from a browser, and both defects were invisible in a
green suite. So before the screenshot:

1. Render `/player/:id` at 390x844 and **look at it** — KPI row mid-fetch, and
   the reordered table. Confirm the placeholder reads as "not yet" and that
   `PTS`/`SNP` are visible without swiping.
2. Re-measure the same geometry the spec recorded, and confirm the document
   still does not scroll sideways (`docScrollWidth === docClientWidth`).
3. Also check 1280x720 desktop: all ten columns still fit, nothing wrapped.

Then regenerate `screenshots/player.png` via the test that produces it.

**`screenshots/analysis.png` and `screenshots/player.png` are already modified in
the working tree from before this branch.** Do not fold those pre-existing
changes into this branch's commits silently — ask which of them belongs here.

---

## Task 4 — full gates

    cd frontend && npm run lint
    cd frontend && npm run test:unit
    cd frontend && caffeinate -i npx playwright test
    cd backend/src && npm test

The Playwright run must be checked against `npx playwright test --list`: a run
that reports a smaller total than the list, or that took far longer than about
six minutes, spanned a sleep and is lying. Re-run rather than debug it.

Backend tests are run even though this branch touches no backend file — cheap,
and it proves the branch is what it claims to be.

---

## Out of scope

`App.css`'s deletion and the three-way `ALLOWED_POS` duplication are recorded in
the spec and stay out of this branch.
