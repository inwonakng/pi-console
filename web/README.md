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
host user, including sessions on its registered hosts. There is no authentication
or encryption.** Use only trusted internal networks/VPNs and firewall rules.

## Listener integration

When enabled, the listener serves `/` (`index.html`), `/app.js`, `/client.js`,
`/style.css`, and the read-only `/v1/hosts` registry. Browser WebSockets at
`/v1/stream` and `/v1/hosts/<key>/stream` must have the same HTTP origin as the page;
connections initiated by unrelated websites are rejected. Registered streams relay
only enabled targets from the serving machine's `hosts.yaml` (`hosts-dev.yaml` for
dev), including local root profiles. Saved host identity pins and the selected
channel are validated before attachment. The browser cannot supply another endpoint
or modify registrations; manage registrations through pi-console's Hosts picker.
Existing non-browser clients remain available regardless of the web frontend
setting. Service administration stays on local IPC, including for relayed profiles.

`client.js` uses the existing protocol-1 LF-delimited JSON records, including
binary WebSocket frames. The listener embeds its channel in the served HTML; the
browser sends that channel in `hello` and still validates the server response.
Session operations use the existing service protocol. Session links use
`/#sessions/<host-id>/<session-id>` so asset serving needs no deep-route fallback.

## Behavior

The permanent Overview tab shows open sessions across the serving host and its
registered hosts, with search and host filtering. Stopped sessions are available
only in History; resuming one requires an explicit action and confirmation.
Archived entries are read-only in this picker.

Opening a conversation creates a tab, or focuses its existing tab. Each tab retains
its attachment, control grant, prompt/answer drafts, expanded output and scroll
position when switching views. Closing a tab detaches without stopping the session;
Stop session is a separate confirmed action. Tabs and drafts are not restored after
page reload. The UI has no fixed tab limit; service connection budgets still apply.

Each open conversation subscribes to updates and coalesces snapshot reads rather
than implementing a second conversation reducer. Stream gaps and disconnects
require explicit reconnection; mutations are never replayed. Refresh hosts reloads
the registry without replacing unchanged tab attachments. Internal empty system
prompt patches and hidden custom messages are omitted from the transcript.

Click `?` for keyboard controls. Outside text fields, Space starts a Neovim-style
leader shortcut; overview navigation supports j/k, Enter, `/`, and H. Standard Tab
navigation remains available, and the focused tab bar supports Left/Right and
Home/End. Ctrl/Cmd+Enter sends a prompt.

The UI supports creation, attachment, control acquisition/takeover/release,
prompts, abort, rename, questions, approvals, and queue inspection. Conversation
content is rendered as text with expandable thinking/tool content. Structured
approval titles expose their scope and preview before answering.
Live editor effects, workspace editing, full history navigation, Markdown
formatting, image display, and offline/installable PWA behavior are outside this
draft.
