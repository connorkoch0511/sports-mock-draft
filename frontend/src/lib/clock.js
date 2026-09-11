/**
 * The clock, as arithmetic.
 *
 * Pure on purpose: this project has no component test stack, so anything that
 * needs real test coverage has to be reachable from node --test. The page
 * below is left with wiring only.
 */

/**
 * How far ahead the server's clock is of this browser's.
 *
 * Measured on every load rather than assumed to be zero, because a laptop
 * running two minutes fast would otherwise see every deadline already passed,
 * render 0, and hammer /expire against a clock that has not run out.
 */
export function skewFrom(serverNow, clientNow = Date.now()) {
  return typeof serverNow === "number" ? serverNow - clientNow : 0;
}

/**
 * Seconds left, or null when the draft carries no deadline at all -- a row
 * written before the clock shipped. Null and 0 must stay distinguishable:
 * one means "no clock here", the other means "time is up, call /expire".
 */
export function remainingSeconds(deadline, skew = 0, clientNow = Date.now()) {
  if (deadline == null) return null;
  return Math.max(0, Math.ceil((deadline - (clientNow + skew)) / 1000));
}

/**
 * Everyone watching notices zero in the same second. Staggering by seat means
 * they arrive in order rather than together: the losers still get a harmless
 * 409, but the logs stay readable.
 */
export function expireDelayMs(seatIndex, step = 250) {
  return Math.max(0, seatIndex) * step;
}

/**
 * Render a countdown the way a person actually reads a clock, not as a raw
 * second count. A pick length can now run to a full day (see the
 * configurable-pick-length work), and "86400s" is not something anyone
 * glances at and understands -- so this scales the format with the
 * magnitude: bare seconds under two minutes, `m:ss` from there, and `h:mm:ss`
 * once the remaining time reaches an hour.
 */
export function formatCountdown(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 120) return `${s}s`;
  const pad2 = (n) => String(n).padStart(2, "0");
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}` : `${mm}:${pad2(ss)}`;
}
