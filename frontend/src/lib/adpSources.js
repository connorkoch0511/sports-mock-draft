/**
 * How a player's ADP reads, wherever it is shown.
 *
 * One module so the draft pool and the board editor cannot drift into showing
 * the same numbers in different orders or with different labels.
 */

// Order is fixed and ours comes first, because ours is the one that tracks the
// league's scoring format and is the number the board is sorted by.
export const SOURCE_LABELS = [
  { key: "ours", label: "ours" },
  { key: "espn", label: "esp" },
  { key: "yahoo", label: "yah" },
];

export const PLATFORM_WIDE_NOTE =
  "ESPN and Yahoo publish one ADP for their whole platform, not one per scoring format.";

export function adpTrio(ourAdp, adpBySource) {
  const src = adpBySource ?? {};
  return SOURCE_LABELS.map(({ key, label }) => {
    const raw = key === "ours" ? ourAdp : src[key];
    // 0 is not a draft position. Treating it as one would sort the player to
    // the very top, which is the most misleading thing this could do.
    const value = typeof raw === "number" && raw > 0 ? raw : null;
    return { key, label, value, text: value == null ? "—" : value.toFixed(1) };
  });
}
