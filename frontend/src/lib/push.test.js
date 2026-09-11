import test from "node:test";
import assert from "node:assert";
import {
  pushSupported,
  pushState,
  urlBase64ToUint8Array,
  subscribe,
  unsubscribe,
} from "./push.js";

/**
 * node:test has no browser. pushSupported/pushState/subscribe/unsubscribe all
 * read `window`, `navigator` and `Notification` as bare globals (the same
 * identifiers a real browser exposes), so a fake shape of each is stood up
 * here and torn down after -- the same trick yahoo.test.js uses for
 * sessionStorage.
 */
function withBrowserGlobals({ permission = "default" } = {}) {
  const notification = { permission };
  globalThis.Notification = notification;
  globalThis.window = { PushManager: function PushManager() {}, Notification: notification };
  globalThis.navigator = { serviceWorker: {} };
}

function clearBrowserGlobals() {
  delete globalThis.Notification;
  delete globalThis.window;
  delete globalThis.navigator;
}

test.afterEach(() => clearBrowserGlobals());

// Independent of the function under test: builds base64url text the same
// way a real VAPID key arrives (standard base64, '+'/'/' swapped, padding
// dropped), using only btoa rather than reaching for Buffer.
function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- urlBase64ToUint8Array -------------------------------------------------

test("urlBase64ToUint8Array round-trips arbitrary bytes encoded as base64url", () => {
  const original = new Uint8Array([0, 1, 2, 3, 16, 32, 64, 128, 253, 254, 255]);
  const encoded = toBase64Url(original);
  const decoded = urlBase64ToUint8Array(encoded);
  assert.deepStrictEqual(Array.from(decoded), Array.from(original));
});

test("urlBase64ToUint8Array handles every padding remainder (0, 1, 2, 3 chars short)", () => {
  for (const length of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const original = new Uint8Array(length).map((_, i) => i * 17);
    const encoded = toBase64Url(original);
    const decoded = urlBase64ToUint8Array(encoded);
    assert.deepStrictEqual(Array.from(decoded), Array.from(original), `length ${length}`);
  }
});

test("urlBase64ToUint8Array translates the url-safe characters standard atob rejects", () => {
  // Bytes chosen so the standard-base64 encoding contains both '+' and '/',
  // which base64url spells as '-' and '_'.
  const original = new Uint8Array([0xfb, 0xff, 0xbf]);
  let binary = "";
  for (const b of original) binary += String.fromCharCode(b);
  const standard = btoa(binary);
  assert.ok(standard.includes("+") || standard.includes("/"), "fixture must exercise +/ chars");
  const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const decoded = urlBase64ToUint8Array(urlSafe);
  assert.deepStrictEqual(Array.from(decoded), Array.from(original));
});

// --- pushSupported / pushState (permission-state reading) ------------------

test("pushSupported is false with no browser globals at all", () => {
  assert.strictEqual(pushSupported(), false);
});

test("pushSupported is true once window/navigator carry serviceWorker, PushManager and Notification", () => {
  withBrowserGlobals();
  assert.strictEqual(pushSupported(), true);
});

test("pushState is unsupported when the browser lacks push support, even with a key", () => {
  assert.strictEqual(pushState("some-key"), "unsupported");
});

test("pushState is unsupported when the browser supports push but no VAPID key is configured", () => {
  withBrowserGlobals();
  assert.strictEqual(pushState(""), "unsupported");
  assert.strictEqual(pushState(undefined), "unsupported");
});

test("pushState reads the live Notification.permission once supported and configured", () => {
  for (const permission of ["granted", "denied", "default"]) {
    withBrowserGlobals({ permission });
    assert.strictEqual(pushState("a-key"), permission);
    clearBrowserGlobals();
  }
});

// --- subscribe ---------------------------------------------------------
//
// subscribe/unsubscribe take their browser calls and their API call as
// injectable arguments (defaulting to the real ones), precisely so these can
// be driven here without a network or a real service worker registration.

test("subscribe returns unsupported without browser support, and calls nothing else", async () => {
  let called = false;
  const result = await subscribe({
    vapidKey: "key",
    requestPermission: () => { called = true; return Promise.resolve("granted"); },
  });
  assert.strictEqual(result, "unsupported");
  assert.strictEqual(called, false);
});

test("subscribe returns unsupported when no VAPID key is configured, and calls nothing else", async () => {
  withBrowserGlobals();
  let called = false;
  const result = await subscribe({
    vapidKey: "",
    requestPermission: () => { called = true; return Promise.resolve("granted"); },
  });
  assert.strictEqual(result, "unsupported");
  assert.strictEqual(called, false);
});

test("a denied permission is returned as-is, without registering a worker or posting anything", async () => {
  withBrowserGlobals();
  let registered = false;
  let posted = false;
  const result = await subscribe({
    vapidKey: "key",
    requestPermission: () => Promise.resolve("denied"),
    registerServiceWorker: () => { registered = true; },
    post: () => { posted = true; },
  });
  assert.strictEqual(result, "denied");
  assert.strictEqual(registered, false);
  assert.strictEqual(posted, false);
});

test("a granted permission registers the worker, subscribes with the VAPID key, and posts endpoint+keys", async () => {
  withBrowserGlobals();
  let subscribeArgs = null;
  let posted = null;
  const fakeSub = {
    toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }),
  };
  const reg = {
    pushManager: {
      subscribe: (opts) => { subscribeArgs = opts; return Promise.resolve(fakeSub); },
    },
  };

  const result = await subscribe({
    vapidKey: toBase64Url([1, 2, 3, 4]),
    requestPermission: () => Promise.resolve("granted"),
    registerServiceWorker: () => Promise.resolve(reg),
    post: (path, body) => { posted = { path, body }; return Promise.resolve({ ok: true }); },
  });

  assert.strictEqual(result, "granted");
  assert.strictEqual(subscribeArgs.userVisibleOnly, true);
  assert.ok(subscribeArgs.applicationServerKey instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(subscribeArgs.applicationServerKey), [1, 2, 3, 4]);
  assert.deepStrictEqual(posted, {
    path: "/push/subscribe",
    body: { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } },
  });
});

test("subscribe waits for the registration to become active before opening a PushManager subscription", async () => {
  // What this pins down: waitUntilActive is called, and it is awaited
  // *before* pushManager.subscribe() runs -- the ordering bug (subscribing
  // against a still-installing worker) is about sequence, and a plain
  // Node fake with no real ServiceWorkerContainer can honestly assert
  // sequence without needing a real "installing -> active" transition.
  // What this does NOT cover: that a real, unresolved `navigator
  // .serviceWorker.ready` genuinely blocks subscribe() from running early --
  // that requires an actual ServiceWorkerContainer, which only a browser
  // has. That gap is real; a Playwright test cannot honestly close it either
  // per the task, since its fake registration exists only as a JS object.
  withBrowserGlobals();
  const calls = [];
  const fakeSub = { toJSON: () => ({ endpoint: "https://push.example/abc", keys: {} }) };
  const reg = {
    pushManager: {
      subscribe: () => {
        calls.push("subscribe");
        return Promise.resolve(fakeSub);
      },
    },
  };

  const result = await subscribe({
    vapidKey: toBase64Url([1, 2, 3, 4]),
    requestPermission: () => Promise.resolve("granted"),
    registerServiceWorker: () => {
      calls.push("register");
      return Promise.resolve(reg);
    },
    waitUntilActive: () => {
      calls.push("ready");
      return Promise.resolve();
    },
    post: () => Promise.resolve({ ok: true }),
  });

  assert.strictEqual(result, "granted");
  assert.deepStrictEqual(calls, ["register", "ready", "subscribe"]);
});

test("subscribe propagates a rejection from waitUntilActive without calling pushManager.subscribe", async () => {
  withBrowserGlobals();
  let subscribeCalled = false;
  const reg = { pushManager: { subscribe: () => { subscribeCalled = true; } } };

  await assert.rejects(
    () =>
      subscribe({
        vapidKey: "key",
        requestPermission: () => Promise.resolve("granted"),
        registerServiceWorker: () => Promise.resolve(reg),
        waitUntilActive: () => Promise.reject(new Error("never became active")),
      }),
    /never became active/
  );
  assert.strictEqual(subscribeCalled, false);
});

// --- unsubscribe -------------------------------------------------------

test("unsubscribe does nothing when the browser is unsupported", async () => {
  let called = false;
  await unsubscribe({ getRegistration: () => { called = true; } });
  assert.strictEqual(called, false);
});

test("unsubscribe does nothing when there is no registration", async () => {
  withBrowserGlobals();
  let deleted = false;
  await unsubscribe({
    getRegistration: () => Promise.resolve(undefined),
    del: () => { deleted = true; },
  });
  assert.strictEqual(deleted, false);
});

test("unsubscribe does nothing when the registration has no subscription", async () => {
  withBrowserGlobals();
  let deleted = false;
  const reg = { pushManager: { getSubscription: () => Promise.resolve(null) } };
  await unsubscribe({
    getRegistration: () => Promise.resolve(reg),
    del: () => { deleted = true; },
  });
  assert.strictEqual(deleted, false);
});

test("unsubscribe unsubscribes the browser subscription and deletes it by endpoint", async () => {
  withBrowserGlobals();
  let unsubscribed = false;
  let deletedWith = null;
  const sub = {
    toJSON: () => ({ endpoint: "https://push.example/xyz" }),
    unsubscribe: () => { unsubscribed = true; return Promise.resolve(true); },
  };
  const reg = { pushManager: { getSubscription: () => Promise.resolve(sub) } };

  await unsubscribe({
    getRegistration: () => Promise.resolve(reg),
    del: (path, body) => { deletedWith = { path, body }; return Promise.resolve({ ok: true }); },
  });

  assert.strictEqual(unsubscribed, true);
  assert.deepStrictEqual(deletedWith, { path: "/push/subscribe", body: { endpoint: "https://push.example/xyz" } });
});
