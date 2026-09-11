// The service worker exists for two moments: a push arrives, and somebody
// clicks it.
//
// It stays silent when this draft's own page is the focused window -- that
// is the one case a notification is genuinely redundant, since whoever it is
// for is already looking at the pick happening. A focused window on any
// *other* page (a player page, a different draft, the dashboard) does not
// suppress: it used to, which meant a 24-hour draft coming to your clock
// while you read a player page notified nobody, silently. Narrowing this is
// what makes notifying on every draft safe rather than maddening: in a
// thirty-second solo draft, only a push for the draft you are actually
// watching would ever have been redundant anyway.
self.addEventListener("push", (event) => {
  const data = (() => {
    try {
      return event.data ? event.data.json() : {};
    } catch {
      return {};
    }
  })();

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const draftPath = data.draftId ? `/draft/${data.draftId}` : null;
      const onThisDraft = (c) => {
        try {
          return new URL(c.url).pathname === draftPath;
        } catch {
          return false;
        }
      };
      if (draftPath && clients.some((c) => c.focused && onThisDraft(c))) return;

      await self.registration.showNotification(data.title || "PerfectPick", {
        body: data.body || "",
        tag: data.draftId ? `draft-${data.draftId}` : "perfectpick",
        data,
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const draftId = event.notification.data?.draftId;
  const url = draftId ? `/draft/${draftId}` : "/";
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clients.find((c) => c.url.includes(url));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })()
  );
});

// A browser can rotate a subscription entirely on its own (a push service
// cycling its keys, the browser deciding an old one is stale) and fires this
// instead of ever calling code in the page. With no listener, the new
// endpoint never reaches the server: the old one starts 410ing, notifier.js
// deletes the row on the next send, and notifications stop forever while the
// page's control still reads "On" -- nothing here can change what it shows,
// a worker has no UI of its own.
//
// push.js has no build step of its own (public/ is copied byte-for-byte, so
// this file never sees import.meta.env), so it cannot import api.js's
// apiPost -- the API's base URL travels on this script's own registration
// URL instead, read back here off self.location.
self.addEventListener("pushsubscriptionchange", (event) => {
  const apiBase = new URL(self.location.href).searchParams.get("apiBase") || "";

  event.waitUntil(
    (async () => {
      try {
        const applicationServerKey =
          event.oldSubscription?.options?.applicationServerKey ||
          event.newSubscription?.options?.applicationServerKey;
        const sub =
          event.newSubscription ||
          (await self.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey,
          }));
        const { endpoint, keys } = sub.toJSON();
        if (!apiBase) return;
        // Posted with no Authorization header -- a worker has no access to
        // the page's in-memory id token (idToken.js), so this will 401
        // against the Cognito-authorized route for a signed-in user's own
        // subscription. Left as a real, known gap rather than pretended
        // away: what this handler does guarantee is that the browser's own
        // PushSubscription stays valid, so the next authenticated visit to
        // the page can pick it back up. Every failure here -- this one
        // included -- is silent by design: there is no UI to report to.
        await fetch(`${apiBase}/push/subscribe`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint, keys }),
        });
      } catch {
        // Silent by design -- see comment above.
      }
    })()
  );
});
