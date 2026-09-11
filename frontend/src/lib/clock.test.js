import test from "node:test";
import assert from "node:assert";
import { skewFrom, remainingSeconds, expireDelayMs, formatCountdown } from "./clock.js";

test("skew is the server's clock minus this browser's", () => {
  assert.equal(skewFrom(1000, 400), 600);
  assert.equal(skewFrom(undefined, 400), 0, "a response without `now` must not shift the clock");
  assert.equal(skewFrom(null, 400), 0);
});

test("a browser running fast does not shorten the turn", () => {
  // Server says it is 1000; this browser thinks it is 3000, two seconds fast.
  const skew = skewFrom(1000, 3000);
  // Deadline is 30s after the server's now.
  assert.equal(remainingSeconds(31000, skew, 3000), 30);
  // Without the correction the same numbers read as 28 -- the fast browser
  // would hand back two seconds of somebody's turn.
  assert.equal(remainingSeconds(31000, 0, 3000), 28);
});

test("remaining time clamps at zero and never goes negative", () => {
  assert.equal(remainingSeconds(1000, 0, 99999), 0);
});

test("no deadline means no countdown, which is not the same as zero", () => {
  assert.equal(remainingSeconds(null, 0, 1000), null);
  assert.equal(remainingSeconds(undefined, 0, 1000), null);
});

test("expire calls are staggered by seat so they do not all arrive together", () => {
  assert.equal(expireDelayMs(0), 0);
  assert.equal(expireDelayMs(3), 750);
  assert.equal(expireDelayMs(-1), 0, "an unknown seat must not produce a negative delay");
});

test("a countdown under two minutes is bare seconds", () => {
  assert.equal(formatCountdown(45), "45s");
  assert.equal(formatCountdown(0), "0s");
  assert.equal(formatCountdown(119), "119s");
});

test("a countdown from two minutes to an hour is m:ss", () => {
  assert.equal(formatCountdown(120), "2:00");
  assert.equal(formatCountdown(599), "9:59");
  assert.equal(formatCountdown(3599), "59:59");
});

test("a countdown of an hour or more is h:mm:ss", () => {
  assert.equal(formatCountdown(3600), "1:00:00");
  assert.equal(formatCountdown(86399), "23:59:59");
  assert.equal(formatCountdown(86400), "24:00:00");
});

test("a non-finite countdown fails safely instead of printing NaN", () => {
  assert.equal(formatCountdown(NaN), "--");
  assert.equal(formatCountdown(undefined), "--");
  assert.equal(formatCountdown(Infinity), "--");
});
