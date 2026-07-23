# Web UI

Run the native control plane and browser UI with:

```sh
maestro web --port 3000
```

The canonical Rust process serves `packages/web/dist`, HTTP APIs, SSE and WebSocket chat, sessions, models, telemetry, automations, A2A, and hosted-runner endpoints. Chat invokes the Rust agent core in a native child only where isolation is required; it never invokes a JavaScript agent.

For local browser development, build or run `packages/web` separately and point it at the native control plane. Production containers contain the Rust executable and compiled static browser assets; Node.js and Bun are absent from the runtime image.

`GET /healthz` is the unauthenticated process health endpoint. Configure authentication and persistence with the `MAESTRO_WEB_*` environment variables documented by `maestro web --help` and the deployment configuration.
