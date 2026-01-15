# Conductor Bridge (Local Development)

This guide describes how to connect the Conductor Chrome extension to a local
Composer web server during development, plus an optional native messaging host
that can launch and monitor Composer automatically.

## Quick Start (HTTP Bridge)

1. Start Composer's web server:

```bash
COMPOSER_WEB_REQUIRE_KEY=0 COMPOSER_WEB_REQUIRE_REDIS=0 COMPOSER_WEB_ORIGIN="*" composer web
```

2. In Conductor settings, enable "Composer Bridge" and set:

```
http://localhost:8080
```

Conductor will fetch `/api/models` and stream `/api/chat` responses from the
Composer server.

## Optional: Native Messaging Host (Auto-Launch + Status)

Composer ships a local native messaging host script at:

```
composer/scripts/bridge/native-host.js
```

The host supports:
- `status` requests (probe `/api/bridge/status`)
- `launch` requests (start `composer web` if needed)
- JSON-RPC notifications (`bridge/status`) when connectivity changes

### Install the native host manifest

1. Copy the example manifest:

```
composer/scripts/bridge/native-host-manifest.example.json
```

2. Replace `path` with the absolute path to `native-host.js`.
3. Replace `YOUR_EXTENSION_ID` with the Conductor extension ID.

Place the manifest in the standard Chrome location:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/`
- Windows: `%LOCALAPPDATA%\\Google\\Chrome\\User Data\\NativeMessagingHosts\\`

### Host configuration (env)

| Variable | Purpose | Default |
| --- | --- | --- |
| `COMPOSER_BRIDGE_BASE_URL` | Base URL to probe/launch | `http://localhost:8080` |
| `COMPOSER_BRIDGE_COMMAND` | Command to launch Composer | `composer` |
| `COMPOSER_BRIDGE_ARGS` | Extra args (JSON array or space-delimited) | empty |
| `COMPOSER_BRIDGE_POLL_MS` | Status poll interval (ms) | `2000` |
| `COMPOSER_BRIDGE_LAUNCH_TIMEOUT_MS` | Launch timeout (ms) | `15000` |

When the host launches Composer, it sets:

```
COMPOSER_WEB_REQUIRE_KEY=0
COMPOSER_WEB_REQUIRE_REDIS=0
COMPOSER_WEB_ORIGIN="*"
```

Unless those variables are already set.

## Notes

- The HTTP bridge supports Conductor client tools (browser automation) because
  the Composer web server exposes the client tool API.
- For production, use explicit API keys and locked CORS origins instead of `*`.
