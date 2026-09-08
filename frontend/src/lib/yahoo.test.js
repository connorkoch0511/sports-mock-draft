import test from "node:test";
import assert from "node:assert";
import { beginYahooAuth, takeStoredState, YAHOO_STATE_KEY } from "./yahoo.js";

// node:test has no browser storage, so stand one up.
function fakeSessionStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
}

test("the authorise url carries the parameters Yahoo needs", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const url = new URL(beginYahooAuth("client-123", "https://example.test/yahoo/callback"));

  assert.strictEqual(url.origin + url.pathname, "https://api.login.yahoo.com/oauth2/request_auth");
  assert.strictEqual(url.searchParams.get("client_id"), "client-123");
  assert.strictEqual(url.searchParams.get("redirect_uri"), "https://example.test/yahoo/callback");
  assert.strictEqual(url.searchParams.get("response_type"), "code");
  assert.ok(url.searchParams.get("state"), "a state must be present");
});

test("the state in the url is the state that was stored", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const url = new URL(beginYahooAuth("c", "https://example.test/cb"));
  assert.strictEqual(url.searchParams.get("state"), globalThis.sessionStorage.getItem(YAHOO_STATE_KEY));
});

// Two runs must not collide, or the guard proves nothing.
test("every attempt gets its own state", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  const a = new URL(beginYahooAuth("c", "https://example.test/cb")).searchParams.get("state");
  const b = new URL(beginYahooAuth("c", "https://example.test/cb")).searchParams.get("state");
  assert.notStrictEqual(a, b);
});

// Reading consumes it, so a callback cannot be replayed by navigating back.
test("the stored state can only be taken once", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  beginYahooAuth("c", "https://example.test/cb");
  const first = takeStoredState();
  assert.ok(first);
  assert.strictEqual(takeStoredState(), null);
});

test("no stored state reads as null rather than throwing", () => {
  globalThis.sessionStorage = fakeSessionStorage();
  assert.strictEqual(takeStoredState(), null);
});

// Privacy modes throw on storage. Starting a flow whose guard cannot be stored
// would leave the callback with nothing to compare against.
test("a storage that throws refuses to start the flow", () => {
  globalThis.sessionStorage = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  assert.throws(() => beginYahooAuth("c", "https://example.test/cb"), /could not start/i);
  assert.strictEqual(takeStoredState(), null);
});
