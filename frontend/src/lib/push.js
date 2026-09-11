/**
 * Asking to be notified of your own turn, and cleaning that up.
 *
 * `import.meta.env` exists under Vite and nowhere else -- read through a
 * fallback (the same trick auth.js uses) so this module, and pushState() in
 * particular, stays importable from the unit tests, which run in plain Node.
 */
const env = (typeof import.meta !== "undefined" && import.meta.env) || {};
const VAPID_PUBLIC_KEY = env.VITE_VAPID_PUBLIC_KEY;

/** Whether this browser can do any of this at all. */
export function pushSupported() {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * "unsupported" | "default" | "granted" | "denied"
 *
 * Takes the VAPID key as an (optional, defaulted) argument rather than
 * reading the module constant directly, so the permission-reading branch
 * below can be exercised from a unit test without a build that carries
 * VITE_VAPID_PUBLIC_KEY.
 */
export function pushState(vapidKey = VAPID_PUBLIC_KEY) {
  if (!pushSupported() || !vapidKey) return "unsupported";
  return Notification.permission;
}

/**
 * The VAPID public key travels as base64url, and PushManager wants bytes.
 * Written out rather than pulled in: it is eight lines and the alternative
 * is a dependency in the browser bundle for a string conversion.
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

// api.js throws at import time when VITE_API_BASE_URL is missing (a real
// guard: every mutating page needs it). Loading it lazily, only on the path
// where a caller hasn't supplied its own `post`/`del`, keeps that guard from
// firing merely because this module was imported -- which is what lets
// push.test.js drive subscribe()/unsubscribe() under plain Node without a
// network or that env var.
async function defaultPost(path, body) {
  const { apiPost } = await import("./api.js");
  return apiPost(path, body);
}

async function defaultDelete(path, body) {
  const { apiDelete } = await import("./api.js");
  return apiDelete(path, body);
}

/**
 * Ask for permission and, if granted, register the service worker, open a
 * push subscription, and hand it to the server.
 *
 * Every browser call below is an injectable argument defaulting to the real
 * thing, so the branching here -- unsupported, denied, granted -- is testable
 * without a browser. Denied is final: the browser will not ask again, so the
 * caller shows that state rather than offering the button once more.
 */
export async function subscribe({
  vapidKey = VAPID_PUBLIC_KEY,
  requestPermission = () => Notification.requestPermission(),
  registerServiceWorker = () => navigator.serviceWorker.register("/sw.js"),
  waitUntilActive = () => navigator.serviceWorker.ready,
  post = defaultPost,
} = {}) {
  if (!pushSupported() || !vapidKey) return "unsupported";

  const permission = await requestPermission();
  if (permission !== "granted") return permission;

  const reg = await registerServiceWorker();
  // register() resolves as soon as the registration record exists -- the
  // worker itself is typically still installing, and reg.active is null
  // until it finishes activating. PushManager.subscribe() throws
  // InvalidStateError against a registration with no active worker, so this
  // looks like a redundant line right up until the first click on a fresh
  // browser fails every time. `ready` is the platform's own promise for
  // "this scope has an active worker".
  await waitUntilActive();
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidKey),
  });

  const { endpoint, keys } = sub.toJSON();
  await post("/push/subscribe", { endpoint, keys });
  return "granted";
}

/** Tear down this browser's subscription, locally and on the server. */
export async function unsubscribe({
  getRegistration = () => navigator.serviceWorker.getRegistration(),
  del = defaultDelete,
} = {}) {
  if (!pushSupported()) return;
  const reg = await getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  const { endpoint } = sub.toJSON();
  await sub.unsubscribe();
  await del("/push/subscribe", { endpoint });
}
