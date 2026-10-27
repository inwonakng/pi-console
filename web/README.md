# Web frontend

Browser assets for the pi-console host. No build step, external fonts, or separate
production process. A push-only service worker supports notifications; it does not
cache pages or session data for offline use.

## Enable and connect

Merge this into `${XDG_CONFIG_HOME:-~/.config}/pi-console/config.yaml`
(`config-dev.yaml` for dev):

```yaml
server:
  webui:
    enabled: true
```

Restart the matching service with `pi-console server restart` (`pi-console-dev
server restart` for dev), then open `http://HOST:8444/` for stable or
`http://HOST:8443/` for dev in a browser. Use the configured port if different;
`server status` reports candidate URLs. The page automatically
connects using the serving host's stable/dev channel and displays it as a read-only
label. The frontend is disabled by default; configuration and asset changes require
a service restart.

For an HTTPS reverse proxy, add the external dashboard origin explicitly:

```yaml
server:
  webui:
    enabled: true
    allowed-origins:
      - https://pi.hyrax-pollux.ts.net
```

`allowed-origins` defaults to an empty list. Entries must be exact HTTP(S) origins
(scheme, hostname, and non-default port if needed), with no path, credentials,
wildcards, or trailing slash. Direct same-origin HTTP access remains available.
The proxy must support WebSocket upgrades; forwarded headers do not grant access.
Install a runtime supporting this setting before adding it to the configuration,
then restart the matching service.

**Anyone who can reach the server port can view and control sessions as the
host user, including sessions on its registered hosts. There is no authentication
or encryption.** Use only trusted internal networks/VPNs and firewall rules.

## Listener integration

When enabled, the listener serves `/` (`index.html`), `/app.js`, `/client.js`,
`/style.css`, and the read-only `/v1/hosts` registry. Browser WebSockets at
`/v1/stream` and `/v1/hosts/<key>/stream` use the page's origin. The listener accepts
its direct HTTP origin and configured `server.webui.allowed-origins` only;
connections initiated by unrelated websites are rejected. Registered streams relay
only enabled targets from the serving machine's `hosts.yaml` (`hosts-dev.yaml` for
dev), including local root profiles. Saved host identity pins and the selected
channel are validated before attachment. The browser cannot supply another endpoint
or modify registrations; manage registrations through pi-console's Hosts picker.
Existing non-browser clients remain available regardless of the web frontend
setting. Confirmed server restart and read-only restart status are available on
direct and registered-host streams. Stop and other service administration remain
local-IPC-only. Anyone with access to these unauthenticated streams can also
request a restart; use the same trusted-network restrictions as session control.

`client.js` uses the existing protocol-1 LF-delimited JSON records, including
binary WebSocket frames. The listener embeds its channel in the served HTML; the
browser sends that channel in `hello` and still validates the server response.
Session operations use the existing service protocol. Session links use
`/#sessions/<host-id>/<session-id>` so asset serving needs no deep-route fallback.

## Behavior

The Settings popup contains Hosts, device notifications, and diagnostics. Hosts
offers Restart server and Last restart for capable servers.
Restart applies the build already installed on the selected host/channel; it does
not install updates or reload this browser page. Active work refuses normally. A
separate force confirmation authorizes interrupting owned work, preserving history
and workspaces. Saved conversations remain stopped until explicitly resumed.
The page reconnects to inspect the original request and reports completion only
when the replacement host, server instance and build match. A lost connection
never resends restart. Drafts remain in the current page; do not reload it to
reconnect. Last restart reads the latest durable outcome, including after a page
reload. If the server cannot return, inspect its private service.log and
service-restart.json on that host before retrying.

The permanent Overview tab shows open sessions across the serving host and its
registered hosts, with search and host filtering. Stopped sessions are available
only in History; resuming one requires an explicit action and confirmation.
Archived entries are read-only in this picker.

Opening a conversation creates a tab, or focuses its existing tab. Each tab retains
its attachment, control grant, prompt/answer drafts, expanded output and scroll
position when switching views. Closing a tab detaches without stopping the session;
Stop session in Session options terminates immediately when the WebUI has control.
Otherwise it asks for confirmation to take control and stop. History is preserved.
Tabs and drafts are not restored after page reload. The UI has no fixed tab limit;
service connection budgets still apply.

Each open conversation subscribes to updates and coalesces snapshot reads rather
than implementing a second conversation reducer. Stream gaps and disconnects
require explicit reconnection; mutations are never replayed. Refresh hosts reloads
the registry without replacing unchanged tab attachments. Internal empty system
prompt patches and hidden custom messages are omitted from the transcript.

All actions use on-screen controls, with no custom keyboard shortcuts. Use Send
to submit a prompt, and the conversation's Actions menu to rename, stop, or create
a new session in the same workspace. Standard browser keyboard navigation remains
available. Settings opens a modal with host connection status and reconnection
controls; registrations for the same host share a single display entry.

The UI supports creation, attachment, control acquisition/takeover/release,
prompts, abort, rename, questions, approvals, and queue inspection. Conversation
content is rendered as text with expandable thinking/tool content. Structured
approval titles expose their scope and preview before answering.
Live editor effects, workspace editing, full history navigation, Markdown
formatting, image display, and offline session access are outside this draft.

## iPhone notifications

Serve the app over HTTPS through a trusted-network reverse proxy and add that
exact HTTPS origin to `server.webui.allowed-origins` as above. Do not expose this
unauthenticated service to the public internet. On iOS 16.4 or later, add the app
to the Home Screen, open it from that icon, then turn on **Settings > Notifications
on this device** and allow the system permission prompt. A browser bookmark alone
is not enough. No Apple Developer account or native app is required.

The switch is off by default and applies only to this device/browser installation.
It persists across page and server restarts. Turning it off unregisters this
subscription without changing desktop delivery or other devices. The existing
per-session **Host notifications** option still controls which events Pi emits;
it must also be on. Needs-input alerts (including approvals/integration), finished,
and error alerts use the same live events as desktop, including enabled registered
remote hosts. The backend sends them even when the phone app is closed. Clicking
an alert opens the corresponding session, preserving drafts in an already-open
app. Stopped sessions still require an explicit resume in History.

The service stores signing keys and subscriptions in its private `web-push.json`
(mode 0600). Keep this file across upgrades; losing it requires enabling
notifications again. Up to 32 device subscriptions are supported. The server
requires outbound HTTPS access to the browser push provider (Apple's
`*.push.apple.com` for iPhone); no public inbound push endpoint is needed. Browser
subscriptions are limited to Apple, Google, and Mozilla push providers to prevent
arbitrary server-side requests. Both subscription updates and status checks require
an allowed browser Origin and JSON, with no cross-origin CORS access.

Notifications can show session names, directories, and remote host aliases on the
Lock Screen. Notification payloads are encrypted in transit to the push provider.
Delivery is best-effort, with a one-hour provider TTL, a bounded in-memory delivery
queue, and no durable retry/replay of missed events. The backend must be running
and online when the event occurs. Invalid/expired subscriptions are removed after
404/410 responses. Reopen Settings to check the subscription and enable it again
if needed. Connectivity and iOS notification/Focus settings can delay or silence
alerts; actual iPhone background delivery needs device verification.
