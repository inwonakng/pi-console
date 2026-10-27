// Push-only worker: do not cache pages, transcripts, or session requests.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
const sessionPath = value => typeof value === "string" && /^\/#sessions\/[\w-]{1,128}\/[\w-]{1,128}$/.test(value) ? value : "/";
self.addEventListener("push", event => {
  let data;
  try { data = event.data?.json(); } catch { /* Always display a visible notification. */ }
  event.waitUntil(self.registration.showNotification(typeof data?.title === "string" ? data.title : "pi-console", {
    body: typeof data?.body === "string" ? data.body : "A session needs your attention.",
    icon: "/apple-touch-icon.png",
    ...(typeof data?.tag === "string" && { tag: data.tag }),
    data: { path: sessionPath(data?.path) },
  }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const path = sessionPath(event.notification.data?.path);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const url = new URL(client.url);
      if (url.origin !== self.location.origin || url.pathname !== "/") continue;
      // Preserve open tabs and drafts instead of navigating/reloading the page.
      client.postMessage({ type: "pi-console-notification", path });
      await client.focus();
      return;
    }
    await self.clients.openWindow(path);
  })());
});
