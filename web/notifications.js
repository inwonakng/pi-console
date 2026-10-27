async function pushRequest(path, method = "GET", value) {
  const response = await fetch(path, { method, cache: "no-store", credentials: "same-origin",
    ...(value && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) }) });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error || `Notification settings unavailable (${response.status}).`);
  }
  return response.json();
}
function applicationKey(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")), char => char.charCodeAt(0));
}

export function setupNotifications(toggle, status) {
  let registration, enabled = false, busy = false, checking;
  const unsupported = !window.isSecureContext ? "Open this app over HTTPS to enable notifications."
    : !("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)
      ? "On iPhone (iOS 16.4+), add this app to your Home Screen and open it there to enable notifications. This browser does not support Web Push."
      : "";
  const render = message => {
    toggle.textContent = enabled ? "On" : "Off";
    toggle.setAttribute("aria-checked", String(enabled));
    toggle.disabled = !!unsupported || busy || !registration || !enabled && Notification.permission === "denied";
    status.textContent = message || unsupported || (enabled
      ? "On for this device, even when the app is closed. Session Host notifications must also be on."
      : Notification.permission === "denied" ? "Notifications are blocked. Allow them in your device's notification settings, then reopen this app."
        : "Off for this device. Enable to receive needs-input, finished, and error notifications.");
  };
  const ready = unsupported ? Promise.resolve() : navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready).then(value => { registration = value; });
  // Install/registration errors are surfaced by refresh, not as unhandled rejections.
  void ready.catch(() => {});
  async function refresh() {
    if (unsupported || busy) { if (unsupported) render(); return; }
    if (checking) return checking;
    checking = (async () => {
      busy = true; render("Checking notification settings...");
      try {
        await ready;
        const current = await registration.pushManager.getSubscription();
        // If status lookup fails, retain the ability to revoke an existing
        // browser subscription rather than falsely presenting it as off.
        enabled = !!current;
        if (current) enabled = (await pushRequest("/v1/push/status", "POST", { endpoint: current.endpoint })).enabled === true;
        render();
      } catch (error) { render(`Could not check notifications: ${error.message}${enabled ? " You can still turn this device off." : ""}`); }
      finally { busy = false; toggle.disabled = !registration || !enabled && Notification.permission === "denied"; }
    })().finally(() => { checking = null; });
    return checking;
  }
  toggle.addEventListener("click", async () => {
    if (busy || unsupported || !registration) return;
    busy = true;
    let created;
    try {
      // iOS requires permission to be requested directly in the tap handler,
      // before awaiting a network request or service-worker operation.
      const permission = !enabled && Notification.permission !== "granted" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
      render(enabled ? "Turning notifications off..." : "Enabling notifications...");
      if (enabled) {
        const current = await registration.pushManager.getSubscription();
        if (current) {
          let serverError;
          try { await pushRequest("/v1/push/subscription", "DELETE", { endpoint: current.endpoint }); }
          catch (error) { serverError = error; }
          // Revoking in the browser also works if the Pi server is unreachable.
          try { await current.unsubscribe(); } catch (error) { if (serverError) throw serverError; }
        }
        enabled = false;
      } else {
        if (await permission !== "granted") throw new Error("Notifications were not allowed. You can change permission in your device's notification settings.");
        const config = await pushRequest("/v1/push");
        const key = applicationKey(config.publicKey);
        let current = await registration.pushManager.getSubscription();
        const previousKey = current?.options.applicationServerKey;
        if (current && (!previousKey || String(new Uint8Array(previousKey)) !== String(key))) {
          await current.unsubscribe();
          current = null;
        }
        if (!current) created = current = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
        await pushRequest("/v1/push/subscription", "POST", { subscription: current.toJSON() });
        enabled = true;
      }
      render();
    } catch (error) {
      if (created) {
        try { await created.unsubscribe(); }
        catch { enabled = true; } // An ambiguous save may have reached the server.
      }
      render(error.message);
    } finally {
      busy = false;
      toggle.disabled = !registration || !enabled && Notification.permission === "denied";
    }
  });
  render(unsupported || "Checking notification settings...");
  void refresh();
  return { refresh };
}
