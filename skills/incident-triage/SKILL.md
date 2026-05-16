---
name: incident-triage
description: Triage production incidents by building a timeline, scoping blast radius, identifying mitigations, and preserving evidence. Use when the user asks about an outage, regression, alert, Sentry issue, or incident follow-up.
license: Complete terms in LICENSE.txt
compatibility: "Maestro skill packages with bounded GitHub MCP tools and executable toolbox entries."
allowed-tools:
  - read
  - search
  - bash
builtin-tools:
  - read
  - search
mode: incident
isolatedContext: true
metadata:
  version: "0.1.0"
  category: evalops-operations
  artifactSchema: evalops.maestro.skill.incident_triage.v1
---

# Incident Triage

Use this skill to turn scattered incident evidence into a concise operator plan.

## Workflow

1. Confirm the symptom, start time, affected surface, and urgency.
2. Load `reference/triage.md` for the detailed timeline and mitigation checklist.
3. Gather only scoped evidence from granted tools and local files. Keep customer data and internal handles out of the normal answer.
4. Build a timeline with known, inferred, and unknown entries separated.
5. Identify the likely owner, immediate mitigation, verification signal, and follow-up issue.
6. End with current state, blast radius, next action, and what evidence was withheld or unavailable.

## Toolbox

Run `toolbox/incident-timeline` to emit the required incident report skeleton.

## MCP Scope

The bundled GitHub MCP config exposes issue, code, workflow, and file lookups for incident context. Live observability systems must be granted by the runtime separately.
