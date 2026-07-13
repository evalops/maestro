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
2. Load learned guidelines (see below) and `reference/triage.md` for the detailed timeline and mitigation checklist.
3. Gather only scoped evidence from granted tools and local files. Keep customer data and internal handles out of the normal answer.
4. Build a timeline with known, inferred, and unknown entries separated.
5. Identify the likely owner, immediate mitigation, verification signal, and follow-up issue.
6. End with current state, blast radius, next action, and what evidence was withheld or unavailable.
7. Record what you learned (see below) so the next incident starts from it.

## Learned Guidelines

This skill accumulates alert-type knowledge across runs in
`~/.maestro/skills/incident-triage/guidelines.md`.

- **At the start of a run**, read that file if it exists and treat its entries as
  priors to verify — which tools, dashboards, owners, and mitigations a given
  alert type needed last time. Confirm they still hold; do not trust them
  blindly.
- **At the end of a run**, append one concise entry mapping the alert type or
  symptom you handled to the tools/interfaces, likely owner, and mitigation that
  actually worked. Keep entries short and free of secrets and customer data.

Programmatic callers can use `loadLearnedGuidelines` /
`appendLearnedGuideline` / `formatLearnedGuidelinesForPrompt` from
the main Maestro package (`src/skills/learned-guidelines.ts`).

## Toolbox

Run `toolbox/incident-timeline` to emit the required incident report skeleton.

## MCP Scope

The bundled GitHub MCP config exposes issue, code, workflow, and file lookups for incident context. Live observability systems must be granted by the runtime separately.
