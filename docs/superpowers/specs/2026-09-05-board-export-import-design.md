# Board Export and Import

**Date:** 2026-09-05
**Status:** Draft — awaiting approval
**Scope:** Export a big board as CSV or JSON; import either back, into a new
board. Frontend only — no API or schema change.

---

## Summary

Send someone your rankings. They import the file and it becomes their board,
theirs to edit.

---

## Motivation

A big board is the most laboured thing in this app: several hundred players
dragged into an order you actually believe in. It is also, since accounts
landed, completely private — there is no way to show it to anyone.

Export and import is the smallest thing that fixes that. It is deliberately
not sharing: no permissions, no live link, no second owner on one board. You
hand somebody a file, they get a copy, and the two boards have nothing to do
with each other afterwards.

The same mechanism happens to cover backing a board up before a big reshuffle,
and editing one in a spreadsheet. Neither is the reason for building it.

---

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Primary purpose | Giving a board to another person | Drives a readable file that carries names, not just opaque ids. |
| Formats | CSV **and** JSON | Matches the draft export the Results page already offers. CSV opens in a spreadsheet; JSON round-trips exactly. |
| File contents | Board name, format, season, and one row per player with rank, name, position, team and id | The id makes matching exact; the name makes the file worth reading and is the fallback. |
| Matching on import | Player id first, normalised name second | Both apps pull the same Sleeper data, so ids nearly always hit. Names cover the rest and make hand-edited files work. |
| Import target | Always a **new** board | Non-destructive. A friend receiving a file wants a copy, not to overwrite something. |
| Imported board name | The file's name plus ` (imported)` | So it cannot be confused with an original of the same name. |
| Unmatched players | Imported anyway, and reported | Refusing 200 players because 3 retired is the wrong trade. |
| Season and format | Informational, not enforced | Importing a 2025 board into 2026 works; departed players fall out naturally. |
| API changes | **None** | Export reads what the page already has. Import is an existing POST then an existing PUT. |

### Why this needs no backend

`GET /boards/{boardId}` already returns `rows` carrying `playerId`, `name`,
`position`, `team` and `myRank` — everything an export needs. And import is:

1. `POST /boards` with the name, format and season → a new board, `version: 1`,
   `order: []`.
2. `PUT /boards/{boardId}` with the matched `order` and `version: 1`.

Both routes exist, are authorised, and are tested. Nothing about this feature
touches the API, the schema, or the template.

### What `reconcile` already does for us

The board page reconciles a stored order against the live pool on every load:
kept players hold their position, departed players are dropped, and unknown
players are inserted after the last kept player with a better consensus rank.

So an import only has to produce **an order of player ids**. Everyone in the
pool who is not in the file is placed sensibly, and the existing changelog
tells the user what moved. No new merging logic is written.

---

## The file

### CSV

```
# PerfectPick board · Sleepers and busts · ppr · 2026
rank,player,position,team,playerId
1,Christian McCaffrey,RB,SF,4034
2,Justin Jefferson,WR,MIN,6794
3,CeeDee Lamb,WR,DAL,6786
```

The comment line carries the metadata a CSV has nowhere else to put. It is
written on export and read on import when present.

A file without it still imports. It takes the name `Imported board`, and —
this is the part worth stating rather than leaving to be discovered — the
**format and season of the importing app's defaults**, `ppr` and the current
season, not of whatever produced the file. A hand-made CSV of player names has
no season, and guessing one from the players in it would be worse than using
the obvious default.

Fields containing a comma or a quote are quoted per RFC 4180. Player names
contain apostrophes and periods routinely and commas occasionally (`Ja'Marr
Chase`, `Michael Pittman Jr.`), so the writer quotes and the reader unquotes
rather than splitting naively on commas.

### JSON

```json
{
  "perfectpickBoard": 1,
  "name": "Sleepers and busts",
  "format": "ppr",
  "season": 2026,
  "players": [
    { "rank": 1, "playerId": "4034", "name": "Christian McCaffrey", "position": "RB", "team": "SF" }
  ]
}
```

`perfectpickBoard` is a format version, so a future change to the shape can be
detected rather than guessed at. An import that does not recognise the version
says so plainly instead of half-working.

### Which format a file is

Sniffed from the content, not the extension — a file renamed `.txt`, or pasted
into a differently-named file, should still work. Content beginning with `{`
after whitespace is parsed as JSON; anything else is parsed as CSV.

---

## Matching

For each row in the file, in order:

1. **By id.** If `playerId` is in the current pool, use it. This is the common
   case and it is exact.
2. **By normalised name.** Lowercase; strip punctuation, accents and the
   suffixes `jr`, `sr`, `ii`, `iii`, `iv`; collapse whitespace. `Ja'Marr Chase`,
   `JaMarr  chase` and `Ja'marr Chase` all normalise alike.
3. **Ambiguous names are not guessed.** If a normalised name matches more than
   one player in the pool, that row is reported as unmatched rather than
   resolved arbitrarily. Two players genuinely share a name often enough in the
   NFL that picking one silently would eventually be wrong.
4. **Duplicates within the file** keep their first occurrence; later ones are
   reported. The board's `order` must not contain duplicates — the API rejects
   that with a 400, so this is enforced before the request rather than after.

---

## What the user sees

**Export** — two buttons on the board page beside the existing controls,
`Export CSV` and `Export JSON`, downloading `<board name>.csv` / `.json` with
the name slugified for the filesystem.

**Import** — an `Import board` control on the Boards page beside `New board`,
opening a file picker. On success it navigates straight to the new board, the
same as creating one.

**The report.** When every row matched, nothing is said — the new board simply
opens. When some did not, the board still opens, with a dismissible notice
naming what was skipped and why:

> Imported 197 of 200 players. Not found: Le'Veon Bell, Rob Gronkowski.
> Ambiguous: Michael Thomas — two players share that name.

Named, not counted. "3 players could not be imported" invites the user to
wonder which, and the answer is already known.

**Failure** says what was wrong: a file that is not a board export, a CSV with
no recognisable columns, unparseable JSON, an unknown format version, or a file
with no usable rows at all. Each of those is a different message.

---

## Risk

**Low, and bounded by being additive.** Nothing existing changes behaviour: no
API, no schema, no existing page's logic. The failure modes are a bad import
producing a wrong board, which the user can delete, or a confusing error.

The one thing worth care is the CSV reader. Hand-edited files are an intended
input, so it must tolerate trailing newlines, `\r\n`, a missing header row, a
missing comment line, extra columns, and columns in a different order — and
reject clearly what it genuinely cannot read.

## Testing

The parsers and the matcher are pure functions and get unit tests: quoted
fields, embedded commas, CRLF, absent metadata, unknown version, ambiguous
name, duplicate rows, empty file, and a full round trip where export output is
fed back to the importer and produces the identical order.

Playwright covers the two paths end to end: exporting a board triggers a
download whose contents match the board on screen, and importing a file
produces a new board in that order — including the partial-match notice, which
is the one piece of UI a user only meets when something has gone slightly
wrong.

## Out of Scope

- **Sharing a board by link, or two people owning one board.** This is a copy
  handed over, deliberately.
- **Replacing an existing board's order from a file.** Import then delete.
- **Importing a draft.** Drafts already export from the Results page; bringing
  one back is a different feature with different questions.
- **Any API or schema change.** If one turns out to be needed, that is a signal
  the design is wrong, not a licence to widen it.
