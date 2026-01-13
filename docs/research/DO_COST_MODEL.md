# Durable Objects Cost Model (Reference)

This document outlines a cost model for a Durable Objects session hub. Prices and
limits should be re-checked before launch (see referenced Cloudflare docs).

## 1) Storage Mode Options (as of Jan 13, 2026)

### A) SQLite-backed Durable Objects

Workers Free:
- Rows read: 5 million / day
- Rows written: 100,000 / day
- SQL stored data: 5 GB total

Workers Paid:
- Rows read: first 25 billion / month included, then $0.001 / million rows
- Rows written: first 50 million / month included, then $1.00 / million rows
- SQL stored data: 5 GB-month included, then $0.20 / GB-month

Billing for SQLite storage begins on January 7, 2026 (no earlier).

### B) Key-value storage backend (Workers Paid only)

- Read request units: 1 million included, then $0.20 / million
- Write request units: 1 million included, then $1.00 / million
- Delete request units: 1 million included, then $1.00 / million
- Stored data: 1 GB included, then $0.20 / GB-month

Request units are 4 KB of data read or written; larger reads/writes consume multiple units.

## 2) Variables

Let:

- `S` = sessions per month
- `E` = events per session
- `R` = average reads per event
- `W` = average writes per event
- `P` = payload size in KB (rounded up to 4 KB units)

Monthly units:

- `read_units = S * E * R * ceil(P / 4)`
- `write_units = S * E * W * ceil(P / 4)`

Add session metadata reads/writes, participant updates, and reconnect snapshots
as separate terms.

## 3) Example (Illustrative)

Assume:
- `S = 100,000` sessions/month
- `E = 50` events/session
- `R = 1` read/event (latest seq)
- `W = 1` write/event (event log)
- `P = 2 KB` -> 1 unit

Then:

- `read_units = 100,000 * 50 * 1 * 1 = 5,000,000`
- `write_units = 100,000 * 50 * 1 * 1 = 5,000,000`

This fits inside the SQLite free quotas on paid plans if those quotas apply.

## 4) Levers to Reduce Costs

- Use compact events (avoid large JSON blobs).
- Keep WebSocket snapshots small; prefer event replay.
- Batch writes when possible (but beware latency).
- Store large artifacts externally and send references.

## 5) Practical Notes

- SQLite-backed DO pricing begins billing on Jan 7, 2026 (per Cloudflare release notes).
- Evaluate tradeoffs between KV storage and SQLite storage based on query patterns.
- Use alarms sparingly; only one alarm per DO instance at a time.
- Duration billing only accrues while a DO is active or idle but non-hibernateable.

## Sources

- Cloudflare Durable Objects pricing
- Cloudflare Durable Objects limits
- Cloudflare Durable Objects lifecycle
- Cloudflare Durable Objects release notes (SQLite billing date)
