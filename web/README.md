# Web frontend

Dependency-free browser assets for the pi-console host. No build step, external
fonts, service worker, or separate production process.

## Enable and connect

Merge this into `${XDG_CONFIG_HOME:-~/.config}/pi-console/config.yaml`
(`config-dev.yaml` for dev):

```yaml
server:
  webui:
    enabled: true
```

Restart the matching service with `pi-console server restart` (`pi-console-dev
server restart` for dev), then open `http://HOST:8443/` in a browser. Use the configured
port if different; `server status` reports candidate URLs. The page automatically
connects using the serving host's stable/dev channel and displays it as a read-only
label. The frontend is disabled by default; configuration and asset changes require
a service restart.

**Anyone who can reach the server port can view and control sessions as the
host user. There is no authentication or encryption.** Use only trusted internal
networks/VPNs and firewall rules.

## Listener integration

When enabled, the listener serves only `/` (`index.html`), `/app.js`, `/client.js`,
and `/style.css`. Browser WebSockets at `/v1/stream` must have the same HTTP origin
as the page; connections initiated by unrelated websites are rejected. Existing
non-browser clients remain available regardless of the web frontend setting.
Service administration stays on local IPC.

`client.js` uses the existing protocol-1 LF-delimited JSON records, including
binary WebSocket frames. The listener embeds its channel in the served HTML; the
browser sends that channel in `hello` and still validates the server response.
No browser-only session operations or HTTP APIs are introduced. Session links use
`/#sessions/<id>` so asset serving needs no deep-route fallback.

## Behavior

The overview subscribes to host summaries. Opening a saved session explicitly
resumes it. The selected session subscribes to updates and coalesces snapshot
reads rather than implementing a second conversation reducer. Stream gaps and
disconnects require explicit reconnection; mutations are never replayed.

The UI supports creation, attachment, control acquisition/takeover/release,
prompts, abort, rename, questions, approvals, and queue inspection. Conversation
content is rendered as text with expandable thinking/tool content. Structured
approval titles expose their scope and preview before answering. Draft prompts
and answers stay in memory across session/control changes, but not page reloads.
Live editor effects, workspace editing, full history navigation, Markdown
formatting, image display, and offline/installable PWA behavior are outside this
draft.
