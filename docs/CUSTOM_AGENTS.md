# Custom agents

Use `maestro_local_host::embedding` when a Rust application needs one local Deixic Code agent session. `EmbeddedAgentBuilder` composes the existing local host and native actor. It returns an `EmbeddedAgentSession` with one command handle and one `FromAgent` event receiver.

The earlier TypeScript plugin-agent snippet is not a supported SDK entry point. This Rust API does not register agent modes, executable tools, or Platform authority.

The compiled [embedding test-kit example](../packages/local-host-rs/examples/embedding_test_kit.rs) shows a caller-owned `lookup_status` tool. Run it without provider credentials:

```bash
cargo run --manifest-path products/maestro/Cargo.toml \
  -p maestro-local-host \
  --example embedding-test-kit \
  --features test-support
```

Caller-owned tools are model-visible definitions. When a call reaches the approval boundary, the embedding receives `FromAgent::ToolCall` and returns one `EmbeddedToolResponse` for the matching call ID. The response is marked `ExecutionSource::RemoteClient`, so caller-supplied text remains an external result in the native loop.

Use the existing runtime-gateway and hosted-runner paths for Platform-managed work. They establish the admitted model, tenant scope, policy, effect execution, and receipts. The local embedding builder does not perform Platform admission or issue Platform receipts.
