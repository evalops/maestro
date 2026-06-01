# Platform Runtime Conformance

[`platform-runtime-conformance.json`](./platform-runtime-conformance.json) pins the release-gated evidence that Maestro joins hosted runtime activity to Platform AgentRuntime and ToolExecution ledgers.

The gate covers:

- AgentRuntime turns, model steps, tool steps, waits, approvals, tool retries, automatic retries, and terminal outcomes.
- ToolExecution linkage from Maestro tool calls to workspace, agent run, step, correlation, approval, retry policy, and recorded output metadata.
- A live Platform AgentRuntime lifecycle smoke path for trigger, claim, step, wait, resume, complete, and event listing.
- Platform A2A live evidence verification for durable task/message/context IDs, invalid-token rejection, source discovery evidence, and trace joins.
- Platform A2A realtime delivery producer evidence for stream events, push callbacks, trace correlation, and operator metrics.
- Platform A2A push-notification callbacks that bind durable message IDs, reject mismatched task/message IDs, preserve tenant/workspace boundaries, and carry trace context into hosted-runner identity.

Run it locally with:

```bash
npm run check:platform-runtime-conformance
```

It is also part of `lint:evals`, so release and mirror validation fail if any required lifecycle claim or anchor disappears.
