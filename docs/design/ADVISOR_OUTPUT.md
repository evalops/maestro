# Advisor Output

Advisor-style agents should make their recommended scope machine-readable. When
the response is plain text, end with:

```text
Effort: <S|M|L|XL> (<rough duration or reason>)
Revisit-if: <signal that would invalidate the estimate>
```

Use the canonical sizes:

- `S`: less than 1 hour
- `M`: 1 to 3 hours
- `L`: 1 to 2 days
- `XL`: more than 2 days, decompose before execution

`Revisit-if` is optional but encouraged when the estimate depends on an
assumption. For JSON-only advisors, emit an equivalent top-level `effort_signal`
object with `size`, `justification`, and optional `revisit_if`.

Callers can parse plain-text advisor output with
`parseAdvisorEffortSignal(output)` from `@evalops/contracts`. Missing signals
return `null` so routers can treat the estimate as unknown instead of failing the
workflow.
