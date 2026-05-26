# CLI Runtime Conformance

The executable fixture lives at
[`test/fixtures/cli-runtime/conformance-v1.json`](../../test/fixtures/cli-runtime/conformance-v1.json).
It pins the public CLI parser behavior that release, install, and automation
smokes depend on:

- text, json, rpc, and headless mode selection
- `--headless` as the headless transport alias
- `exec`, `run`, `remote`, `codex login`, and `config init` argument ownership
- fail-fast handling for invalid task budgets and unknown options
- static anchors for the JSON-over-stdio RPC surface

Run the gate with:

```bash
npm run check:cli-runtime-conformance
```

This check is wired into `lint:evals` so parser or RPC drift blocks normal
release validation before it can reach the published package smoke tests.
