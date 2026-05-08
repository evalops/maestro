# Conductor Bridge (Local Development)

This guide describes how to connect the Conductor Chrome extension to a local
Maestro web server during development, plus an optional native messaging host
that can launch and monitor Maestro automatically.

## Quick Start (HTTP Bridge)

1. Start Maestro's web server:

```bash
MAESTRO_WEB_REQUIRE_KEY=0 MAESTRO_WEB_REQUIRE_REDIS=0 MAESTRO_WEB_ORIGIN="*" maestro web
```

2. In Conductor settings, enable "Maestro Bridge" and set:

```
http://localhost:8080
```

Conductor will fetch `/api/models` and stream `/api/chat` responses from the
Maestro server.

## Capabilities (Client-Side Tools)

When the Conductor extension is connected, Maestro can delegate browser actions
to the client. These tools execute inside the browser context and return results
to the server.

| Category | Examples |
| --- | --- |
| Read & search | `read_page`, `search_page`, `find_on_page`, `extract_links`, `extract_table_data`, `extract_document` |
| Navigation & tabs | `navigate_to`, `open_links_in_tabs`, `wait_for_selector`, `scroll_page` |
| Interaction | `click_element`, `type_text`, `select_element`, `highlight_element`, `mouse_action`, `pointer_action`, `keyboard_action` |
| Diagnostics | `capture_screenshot`, `capture_network`, `capture_console_errors`, `collect_diagnostics` |
| Native actions (CDP) | `native_click`, `native_type`, `native_press`, `native_key_down`, `native_key_up` |
| Skills & artifacts | `run_skill`, `manage_artifact`, `patch_artifact` |
| MCP bridging | `list_mcp_servers`, `list_mcp_tools`, `list_mcp_resources`, `read_mcp_resource` |

## Optional: Native Messaging Host (Auto-Launch + Status)

Maestro ships a local native messaging host script at:

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
| `MAESTRO_BRIDGE_COMMAND` | Command to launch Maestro | `maestro` |
| `MAESTRO_BRIDGE_ARGS` | Extra args (JSON array or space-delimited) | empty |
| `MAESTRO_BRIDGE_POLL_MS` | Status poll interval (ms) | `2000` |
| `MAESTRO_BRIDGE_LAUNCH_TIMEOUT_MS` | Launch timeout (ms) | `15000` |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_URL` | Optional Agent Runtime base URL for browser-control decision events | empty |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_TOKEN` | Optional bearer token for Agent Runtime | empty |
| `MAESTRO_BRIDGE_AGENT_RUNTIME_ORG_ID` | Optional organization header for Agent Runtime | empty |
| `MAESTRO_BRIDGE_PLATFORM_RUN_ID` | Fallback Platform run ID when the Conductor receipt does not include one | empty |
| `MAESTRO_BRIDGE_PLATFORM_RUNTIME_TIMEOUT_MS` | Agent Runtime event write timeout (ms) | `2000` |

When the host launches Maestro, it sets:

```
MAESTRO_WEB_REQUIRE_KEY=0
MAESTRO_WEB_REQUIRE_REDIS=0
MAESTRO_WEB_ORIGIN="*"
```

Unless those variables are already set.

When `onBrowserControlDecision` includes `platformRunId`, the native host writes
a channel-safe `RUNTIME_EVENT_TYPE_AGENT_PROGRESS_RECORDED` event with
`schemaVersion=browser-control-runtime-decision/v1`. Platform projects that
event into the browser-control decision metric and Deploy alerts on missing or
invalid Platform receipts.

## Notes

- The HTTP bridge supports Conductor client tools (browser automation) because
  the Maestro web server exposes the client tool API.
- For production, use explicit API keys and locked CORS origins instead of `*`.

## Security & CORS Guidance

For local development, the quick-start command disables API keys and allows all
origins. For shared or production deployments, tighten these settings:

- Set `MAESTRO_WEB_REQUIRE_KEY=1` and configure an API key.
- Lock CORS to your extension origin (and any other approved origins):
  - `MAESTRO_WEB_ORIGIN="chrome-extension://<extension-id>"`
  - Add any additional allowed origins as needed.
- Keep the bridge on localhost unless you explicitly need remote access.
