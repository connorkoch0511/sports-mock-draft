// The service worker exists for two moments: a push arrives, and somebody
// clicks it.
//
// It stays silent when a window on this origin is already focused. That is
// what makes notifying on every draft safe rather than maddening: in a
// thirty-second solo draft every pick is your turn, and a notification is
// only ever useful when you are NOT looking at the page.
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
      if (clients.some((c) => c.focused)) return;

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
