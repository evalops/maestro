---
name: security-review
description: Correctness-first, depth-first security audit of a single repository using STRIDE, OWASP Top 10, the OWASP LLM Top 10, and supply-chain analysis. Use when the user asks for a security review, a vulnerability audit, a threat model, or a pre-release security pass.
license: Complete terms in LICENSE.txt
compatibility: "Maestro skill packages with read/search/bash access to a single checked-out repository."
allowed-tools:
  - read
  - search
  - bash
builtin-tools:
  - read
  - search
mode: review
isolatedContext: true
metadata:
  version: "0.1.0"
  category: evalops-operations
  artifactSchema: evalops.maestro.skill.security_review.v1
---

# Security Review

Produce a depth-first security audit of one repository. Depth beats breadth: a
small number of substantiated, exploitable findings is worth more than a long
list of pattern matches. Every finding must trace a concrete path from an
untrusted input to a dangerous sink, with `file:line` evidence. Do not report a
finding you cannot substantiate by reading the code.

## Workflow

1. **Scope.** Identify the languages, frameworks, entry points (HTTP routes,
   CLI, queue consumers, webhooks), trust boundaries, and where untrusted input
   enters. Note authentication and authorization surfaces.
2. **Threat model (STRIDE).** Enumerate threats per trust boundary using the
   STRIDE categories in `reference/rubric.md`. This drives where you look; it is
   not itself a finding list.
3. **Trace data flow.** For each candidate issue, follow the data from source
   (untrusted input) to sink (query, exec, deserialization, file path, template,
   model prompt, response). Confirm there is no effective sanitization on the
   path before recording a finding.
4. **Apply the catalogs.** Check against OWASP Top 10, the OWASP LLM Top 10 (for
   any LLM/agent surface), and supply-chain risks — all detailed in
   `reference/rubric.md`. Load that file when you need the full checklists. If a
   catalog check surfaces a new candidate, send it back through step 3 and report
   it only after the source→sink trace is substantiated.
5. **Rate and write up.** Assign severity with the rubric. Each finding gets:
   title, severity, location (`file:line`), the source→sink path, impact, and a
   concrete, minimal fix.
6. **Report.** Lead with findings ordered by severity. If you find nothing
   exploitable, say so plainly and name the residual risk you could not rule out
   (e.g. dependencies you did not audit, code paths you could not reach).

## Findings Artifact

Emit findings as `evalops.maestro.skill.security_review.v1`: a list of findings,
each with `id`, `title`, `severity` (critical | high | medium | low | info),
`category` (stride/owasp/owasp-llm/supply-chain), `location`, `path`, `impact`,
and `fix`. Include a short `summary` with counts by severity and the scope you
actually covered.

## Discipline

- No speculative findings. If you cannot show the vulnerable path, it is not a
  finding — at most a note in residual risk.
- Prefer reading the real code over running scanners; if you run a scanner (e.g.
  `semgrep`, `npm audit`), treat its output as leads to verify, not findings.
- Never exfiltrate secrets you discover. Report the location and the exposure,
  redact the value.
