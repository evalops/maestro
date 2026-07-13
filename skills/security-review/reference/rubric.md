# Security Review Rubric

Load this file when you need the full checklists and the severity rubric. It is
intentionally kept out of the main skill body so the agent only pays for it when
a review is actually underway.

## Severity

| Severity | Meaning |
| --- | --- |
| critical | Remotely exploitable with no auth, or trivial privilege escalation / RCE / full data exfiltration. Fix before release. |
| high | Exploitable with some precondition (auth, specific input, race). Real impact on confidentiality, integrity, or availability. |
| medium | Exploitable only with significant preconditions, or limited blast radius. Defense-in-depth gap. |
| low | Hardening issue, weak default, or risk that requires an unlikely chain. |
| info | Observation worth recording; not exploitable on its own. |

Rate by realistic impact and exploitability of the **traced path**, not by the
category. A SQL string concatenation behind three layers of validation is not a
critical.

## STRIDE (threat model)

Walk each trust boundary and ask what each category enables:

- **Spoofing** — can an actor claim another identity? (auth, session, tokens,
  signature verification, TLS validation)
- **Tampering** — can data or code be modified in transit or at rest? (integrity
  checks, signed artifacts, mass-assignment, mutable shared state)
- **Repudiation** — can an action be denied? (audit logging, tamper-evident
  logs)
- **Information disclosure** — can secrets or data leak? (error messages, debug
  endpoints, directory listing, verbose logs, IDOR)
- **Denial of service** — can an actor exhaust resources? (unbounded input,
  regex catastrophic backtracking, zip bombs, missing rate limits)
- **Elevation of privilege** — can an actor gain capabilities? (authorization
  gaps, path traversal, deserialization, command injection)

## OWASP Top 10 (2021)

1. Broken access control (IDOR, missing authz on object/function, path
   traversal, forced browsing).
2. Cryptographic failures (plaintext secrets, weak/legacy algorithms, missing
   TLS verification, predictable randomness).
3. Injection (SQL/NoSQL, OS command, LDAP, XPath, template injection, XSS).
4. Insecure design (missing threat model, unsafe-by-default flows).
5. Security misconfiguration (debug on, default creds, permissive CORS, open S3,
   verbose errors).
6. Vulnerable and outdated components (see Supply Chain below).
7. Identification and authentication failures (weak session handling, credential
   stuffing exposure, missing MFA on sensitive flows).
8. Software and data integrity failures (unsigned updates, insecure
   deserialization, CI/CD trust).
9. Security logging and monitoring failures (no audit trail on sensitive
   actions).
10. Server-side request forgery (unvalidated outbound URLs / fetchers).

## OWASP LLM Top 10

Apply to any prompt, agent, tool-calling, or RAG surface:

1. Prompt injection (direct and indirect, including via retrieved/tool content).
2. Sensitive information disclosure (secrets or PII leaking into prompts,
   completions, or logs).
3. Supply chain (untrusted models, plugins, datasets).
4. Data and model poisoning.
5. Improper output handling (model output flowing unsanitized into a sink — SQL,
   shell, HTML, downstream tool calls).
6. Excessive agency (tools with more authority than the task needs; missing
   human approval on destructive actions).
7. System prompt leakage (secrets or trust-bearing instructions in the system
   prompt).
8. Vector and embedding weaknesses (injection or poisoning via the retrieval
   store).
9. Misinformation / overreliance (acting on unverified model claims).
10. Unbounded consumption (token/cost exhaustion, denial of wallet).

## Supply Chain

- Pinned, integrity-checked dependencies (lockfiles, hashes) vs. floating
  ranges.
- Known-vulnerable versions (`npm audit`, `pip-audit`, `osv-scanner` as leads).
- Install/build scripts that execute on `install` (postinstall hooks).
- Typosquat / dependency-confusion risk on internal package names.
- CI/CD: secrets in workflow logs, unpinned actions, write tokens on PRs from
  forks.
