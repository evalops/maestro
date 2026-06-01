# RPC Protocol Conformance

The executable fixture lives at
[`test/fixtures/rpc/protocol-v1.json`](../../test/fixtures/rpc/protocol-v1.json).
It pins the JSON-over-stdio contract used by embedded clients and release E2E
smokes:

- `prompt`, `abort`, `get_messages`, `get_state`, `continue`, and `compact`
  command shapes
- request-id correlation for request-response commands
- unknown-command error behavior
- the typed client launching Maestro with `--mode rpc`
- runtime tests that exercise correlated state, message, compaction, and error
  responses

Run the gate with:

```bash
npm run check:rpc-protocol-conformance
```

This check is wired into `lint:evals` so RPC drift blocks release validation
before published install and replay smokes depend on the protocol.
