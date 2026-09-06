# Conductor Bridge (Local Development)

This guide describes how to connect the Conductor Chrome extension to a local
Deixic Code web server during development, plus an optional native messaging host
that can launch and monitor Deixic Code automatically.

## Quick Start (HTTP Bridge)

1. Start Deixic Code's web server, allowing your Conductor extension's origin:

```bash
MAESTRO_WEB_REQUIRE_REDIS=0 \
  MAESTRO_WEB_ORIGIN="chrome-extension://<CONDUCTOR_EXTENSION_ID>" \
  maestro web
```

`maestro web` binds to `127.0.0.1` and runs without an API key by default, so
`MAESTRO_WEB_REQUIRE_KEY=0` is unnecessary here. Never set
`MAESTRO_WEB_ORIGIN="*"`: it tells the server to accept every origin, so any
page you visit while the server is running can call the local agent runtime.

2. In Conductor settings, enable "Maestro Bridge" (the extension's legacy compatibility label) and set:

```
http://localhost:8080
```

Conductor will fetch `/api/models` and stream `/api/chat` responses from the
Deixic Code server.

## Capabilities (Client-Side Tools)

When the Conductor extension is connected, Deixic Code can delegate browser actions
to the client. These tools execute inside the browser context and return results
to the server.

| Category | Examples |
| --- | --- |
| Operator loop | `browser_operator` observes the active page, performs one semantic action, and returns verification plus latest page state |
| Read & search | `read_page`, `search_page`, `find_on_page`, `extract_links`, `extract_table_data`, `extract_document` |
| Navigation & tabs | `navigate_to`, `open_links_in_tabs`, `wait_for_selector`, `scroll_page` |
| Interaction | `click_element`, `type_text`, `select_element`, `highlight_element`, `mouse_action`, `pointer_action`, `keyboard_action` |
| Diagnostics | `capture_screenshot`, `capture_network`, `capture_console_errors`, `collect_diagnostics` |
| Native actions (CDP) | `native_click`, `native_type`, `native_press`, `native_key_down`, `native_key_up` |
| Skills & artifacts | `run_skill`, `manage_artifact`, `patch_artifact` |
| MCP bridging | `list_mcp_servers`, `list_mcp_tools`, `list_mcp_resources`, `read_mcp_resource` |

`browser_operator` is the preferred task-level browser-control surface. Call it
first with `phase: "observe"`, a `goal`, and no action to inspect the current
page. Then call it with `phase: "act"`, the same `goal`, the prior
`previous_observation_id` when available, an `expected_result`, and exactly one
semantic action such as `{ "kind": "click", "refId": "..." }`,
`{ "kind": "type", "refId": "...", "text": "..." }`, or
`{ "kind": "select", "selector": "...", "value": "..." }`.

Prefer the `refId` returned by observation over a CSS selector. For targets
inside embedded apps or iframes, preserve both `frameId` and `refId` from the
observed element and send them back with the action. Use `include_frames: true`
on observe/recover calls when the target may be inside a frame. Observation
results may also include page-observer freshness metadata; if a frame changed
after the prior observation, recover by observing again before retrying.

Conductor executes the action in the active tab, refreshes the page observation,
and returns verification fields instead of making the model infer success from a
low-level click or keypress alone. If verification fails or the ref/selector is
stale, call `browser_operator` again with `phase: "recover"` and no typed secret
values; the client should re-observe before retrying.

## Optional: Native Messaging Host (Auto-Launch + Status)

Deixic Code ships a local native messaging host script at:

```
composer/scripts/bridge/native-host.js
```

The host supports:
- `status` requests (probe `/api/bridge/status`)
- `launch` requests (start `maestro web` if needed)
- JSON-RPC notifications (`bridge/status`) when connectivity changes
- CRX-style browser-control decision notifications
  (`onBrowserControlDecision`) forwarded to Platform `RecordRunEvent` when
  Agent Runtime configuration is present

### Install the native host manifest

1. (Recommended) Run the installer script:

```
node composer/scripts/bridge/install-native-host.mjs --extension-id <CONDUCTOR_EXTENSION_ID>
```

This attempts to auto-detect the extension ID (via `CONDUCTOR_EXTENSION_ID`,
`CONDUCTOR_PEM_PATH`, or an installed Chrome profile) and writes the manifest to
the correct OS location.

2. Or copy the example manifest:

```
composer/scripts/bridge/native-host-manifest.example.json
```

3. Replace `path` with the absolute path to `native-host.js`.
4. Replace `YOUR_EXTENSION_ID` with the Conductor extension ID.

Place the manifest in the standard Chrome location (if you did not use the script):

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/`
- Windows: `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\NativeMessagingHosts\\`

### Host configuration (env)

| Variable | Purpose | Default |
| --- | --- | --- |
| `MAESTRO_BRIDGE_BASE_URL` | Base URL to probe/launch | `http://localhost:8080` |
| `MAESTRO_BRIDGE_COMMAND` | Command to launch Deixic Code | `maestro` |
| `MAESTRO_BRIDGE_ARGS` | Extra args (JSON array or space-delimited) | empty |
| `MAESTRO_BRIDGE_POLL_MS` | Status poll interval (ms) | `2000` |
| `MAESTRO_BRIDGE_LAUNCH_TIMEOUT_MS` | Launch timeout (ms) | `15000` |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_URL` | Optional Agent Runtime base URL for browser-control decision events | empty |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_TOKEN` | Optional bearer token for Agent Runtime | empty |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_ORG_ID` | Optional organization header for Agent Runtime | empty |
| `MAESTRO_BRIDGE_PLATFORM_RUN_ID` | Fallback Platform run ID when the Conductor receipt does not include one | empty |
| `MAESTRO_BRIDGE_PLATFORM_RUNTIME_TIMEOUT_MS` | Agent Runtime event write timeout (ms) | `2000` |

When the host launches Deixic Code, and unless the variable is already set, it
sets:

```
MAESTRO_WEB_REQUIRE_REDIS=0
MAESTRO_WEB_ORIGIN="chrome-extension://<calling-extension-id>"
```

The extension ID comes from the origin argument Chrome passes to the native
messaging host, or from `CONDUCTOR_EXTENSION_ID`. When neither is available the
host leaves `MAESTRO_WEB_ORIGIN` unset so the server keeps its built-in
localhost allowlist; it never falls back to `*`.

The host does not set `MAESTRO_WEB_REQUIRE_KEY`. Deixic Code's default loopback bind
already runs without an API key, and forcing the kill switch on would strip auth
from a non-loopback bind an operator configured deliberately.

When `onBrowserControlDecision` includes `platformRunId`, the native host writes
a channel-safe `RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED` event with
`schemaVersion=browser-control-runtime-decision/v1`. Platform projects that
event into the browser-control decision metric and Deploy alerts on missing or
invalid Platform receipts.

## Notes

- The HTTP bridge supports Conductor client tools (browser automation) because
  the Deixic Code web server exposes the client tool API.
- Never use `MAESTRO_WEB_ORIGIN="*"`, in development or production.

## Security & CORS Guidance

The bridge exposes tool execution, so treat its CORS configuration as an
authorization boundary:

- Lock CORS to your extension origin:
  `MAESTRO_WEB_ORIGIN="chrome-extension://<extension-id>"`. The server also
  accepts the built-in `localhost`/`127.0.0.1` development origins so the web UI
  keeps working.
- `MAESTRO_WEB_ORIGIN="*"` means "this is a public API". The server answers with
  a literal `Access-Control-Allow-Origin: *` and withholds
  `Access-Control-Allow-Credentials`, but it still accepts WebSocket upgrades
  from any origin, so a wildcard is never appropriate for a local bridge.
- Keep the bridge on localhost unless you explicitly need remote access. On a
  non-loopback bind the server requires auth and refuses to start with
  `MAESTRO_WEB_REQUIRE_KEY=0`.
- On a loopback bind the server also validates the `Host` header and answers
  `421 Misdirected Request` for names that do not resolve to that interface, so
  a DNS-rebinding page cannot reach the bridge. Use `MAESTRO_WEB_ALLOWED_HOSTS`
  if you front the bridge with a tunnel that rewrites `Host`.
- For shared deployments set `MAESTRO_WEB_REQUIRE_KEY=1` and configure
  `MAESTRO_WEB_API_KEY`.
