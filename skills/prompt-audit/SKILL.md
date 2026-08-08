---
name: prompt-audit
description: Inspect the current Maestro system prompt's fragment order, provenance, sizes, hashes, and deterministic audit findings. Use when debugging prompt composition, cache misses, duplicated instructions, or missing prompt provenance.
user-invocable: true
disable-model-invocation: true
argument-hint: ""
metadata:
  version: "0.1.0"
  category: diagnostics
  artifactSchema: evalops.maestro.prompt_audit.v1
---

# Prompt Audit

1. Run `/context audit` in the active Maestro session.
2. Check the model, total token count, total prompt hash, and fragment order.
3. Use each fragment's name, source, byte count, token count, and SHA-256 value to locate composition changes.
4. Resolve `duplicate_fragment` findings by tracing the listed fragment sources. Resolve `missing_provenance` findings by assigning the missing name or source.
5. Keep fragment bodies out of reports and session artifacts. The audit output contains hashes and counts. It excludes prompt text.
