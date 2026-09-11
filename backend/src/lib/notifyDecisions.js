// backend/src/lib/notifyDecisions.js
//
// Who gets told, and what. A pure function of the draft's before and after
// images, so the whole decision is testable without AWS, a network, or a
// push service -- which matters because this is the part that decides
// whether somebody's phone buzzes at midnight.
//
// Every write to a draft lands on the stream that calls this: pauses, board
// changes, seat-board writes, deletes. Only an advancing currentIndex means
// a turn changed hands.

function seatFor(image, team) {
  return (image.seats || []).find((s) => s?.team === team) || null;
}

/**
 * @returns {Array<{sub: string, kind: "your-turn"|"picked-for-you", draftId: string, title: string, body: string}>}
 */
function decideNotifications(oldImage, newImage) {
  if (!oldImage || !newImage) return [];

  const before = oldImage.currentIndex ?? 0;
  const after = newImage.currentIndex ?? 0;
  if (!(after > before)) return [];

  const picks = newImage.picks || [];
  const out = [];

  // Every pick that just completed. Told only when the clock made it: a person
  // who picked for themselves does not need telling they did. Scan the full range
  // rather than a single index, because a single write can advance by multiple
  // picks—and whether it does depends on unrelated implementation details
  // (like whether the clock re-reads between picks) that could change.
  for (let i = before; i < after; i++) {
    const done = picks[i];
    if (done?.auto) {
      const seat = seatFor(newImage, done.team);
      if (seat?.kind === "human" && seat.sub) {
        out.push({
          sub: seat.sub,
          kind: "picked-for-you",
          draftId: newImage.draftId,
          title: "Your clock ran out",
          body: `We picked ${done.player?.name || "a player"} for you.`,
        });
      }
    }
  }

  // Whoever is now on the clock. A completed draft has nobody.
  const next = picks[after];
  if (next) {
    const seat = seatFor(newImage, next.team);
    if (seat?.kind === "human" && seat.sub) {
      out.push({
        sub: seat.sub,
        kind: "your-turn",
        draftId: newImage.draftId,
        title: "You're on the clock",
        body: "It's your pick.",
      });
    }
  }

  return out;
}

module.exports = { decideNotifications };
