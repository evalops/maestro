# DO Session Hub (Prototype)

Minimal Durable Objects session hub example for Composer.

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
3. Connect a WebSocket client to `/sessions/<id>/ws`
4. POST events to `/sessions/<id>/events`
5. Replay events with `GET /sessions/<id>/events?since=<seq>&limit=<n>`

## Notes

This is a prototype and not wired into Composer's build.
