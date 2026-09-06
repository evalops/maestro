# Incident Triage Reference

## Cerebro Query Patterns

Run these against the Cerebro MCP gateway (`POST /mcp`, streamable HTTP
JSON-RPC; manifest at `GET /.well-known/evalops/cerebro-mcp.json`) before
querying raw logs or metrics. All tools below are shipped read tools requiring
the `cerebro:read` scope; the workspace comes from the
`X-EvalOps-Workspace-Id` / `X-Cerebro-Workspace-Id` session header, never from
a tool argument.

Per entity extracted from the alert:

- **Service or workload**: `cerebro_gather_facts` with
  `{"query": "<service>", "include_map": true, "retrieval_limit": 10}` to get
  the Thing, its current Facts, and linked Things in one call. Then
  `cerebro_get_thing` with `{"thing_id": "<id>"}` for recent Events (deploys,
  prior alerts, incidents) and Evidence.
- **Image digest**: `cerebro_search` with `{"query": "<digest>"}` to find the
  Things (services, deploys) that reference the build, then `cerebro_get_thing`
  on each hit.
- **Domain**: `cerebro_search` with `{"query": "<domain>"}`; follow with
  `cerebro_map_thing` `{"thing_id": "<id>", "depth": 2}` for the owning
  services and downstream dependencies.
- **Actor**: `cerebro_search` with `{"query": "<actor>"}` for the person or
  agent Thing, then `cerebro_get_thing` for their recent Events.

Cross-cutting memory queries:

- **Prior incidents and changes**: recent Events from `cerebro_get_thing` are
  the per-entity history. `cerebro_list_changes` only accepts `limit` through
  the MCP gateway today, so use it as a workspace-wide recent-change scan, not
  a per-entity filter.
- **Active predictions**: `cerebro_list_predictions` with
  `{"subject_thing_id": "<id>", "limit": 10}` lists durable prediction-ledger
  Facts for the entity.
- **Open attention items**: `cerebro_attention_lifecycle` with
  `{"state": "OPEN", "limit": 25}` — it adds lifecycle state and next-step
  hints that plain `cerebro_list_attention` (limit only) does not.
- **Last-known resolution**: `cerebro_action_experiences` with
  `{"target_system": "<system>", "limit": 10}` compiles terminal remediation
  Actions into lessons and replay hints; `cerebro_action_outcome_ledger` shows
  whether proposed or queued follow-ups are still waiting for an outcome.
- **Conflicting beliefs**: `cerebro_debug_beliefs` with `{"thing_id": "<id>"}`
  when the alert contradicts what Cerebro believes.
- **Coverage check**: `cerebro_source_health` with
  `{"source_systems": ["<system>"], "max_age_hours": 24}` before trusting an
  empty result — a stale or missing source means fall back to raw evidence.

Never put tenant IDs, pod UIDs, or secrets into query strings; prefer stable
service, deployment, repo, and digest identities.

## Timeline Discipline

- Known: directly observed logs, alerts, commits, deploys, or operator reports.
- Inferred: plausible links that need confirmation.
- Unknown: missing evidence that affects the decision.

## Mitigation Checklist

1. Is the incident still active?
2. What changed before the first symptom?
3. Which customers, tenants, or environments are affected?
4. Is there a reversible mitigation?
5. What signal proves recovery?
6. What follow-up issue or post-incident artifact is needed?

## Answer Shape

Use concise sections: current state, blast radius, likely cause, mitigation, verification, next action, withheld or unavailable evidence.
