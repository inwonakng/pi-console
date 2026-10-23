# Web frontend

Dependency-free browser assets for the pi-console host. No build step, external
fonts, service worker, or separate production process.

The host listener integration is intentionally separate from this draft. The
current listener does not serve these files or accept browser connections yet.

## Listener integration

- Read `server.webui.enabled` from `pi-console-config.yaml` (default `false`).
  The shared settings reader validates and returns this option; it does not
  enable a listener itself.
- When enabled, serve `index.html` at `/`, and `app.js`, `client.js`, and
  `style.css` alongside it. Serve only these assets, not arbitrary host files.
- Provide an authenticated, same-origin WebSocket at `/v1/stream`. Browser
  authentication and origin checks belong to the listener; this frontend does
  not put device secrets in URLs or browser storage.

`client.js` uses the existing protocol-1 LF-delimited JSON records, including
binary WebSocket frames. The selected channel is sent in `hello`. No browser-only
session operations or HTTP APIs are introduced. Session links use
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
