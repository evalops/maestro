# DO Session Hub (Prototype)

Minimal Durable Objects session hub example for Maestro.

## What it shows

- Routing WebSocket sessions to a Durable Object by session ID
- Fan-out broadcasting to connected clients
- Basic event ingestion from a runner via HTTP
- Small per-socket attachments for hibernation-safe metadata

## Not included

- Auth / ACL checks
- Durable SQLite schema
- Backpressure or rate limiting
- Full event replay

## Run locally (Cloudflare Workers)

1. Install `wrangler`
2. `wrangler dev` from this directory
3. Open `http://localhost:8787/demo` for a demo client
4. Or connect a WebSocket client to `/sessions/<id>/ws`
5. POST events to `/sessions/<id>/events`
6. Replay events with `GET /sessions/<id>/events?since=<seq>&limit=<n>`

## Notes

This is a prototype and not wired into Maestro's build. The demo replay button fetches
events in pages of 100 (up to 5 pages per click); click Replay again to continue.
