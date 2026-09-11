# Dynamic swarm execution

`maestro-swarm` exposes `SwarmExecutor::run_expanding` for execution owners
that discover work while running a task graph. A callback receives its task
and the results of its direct dependencies, and returns a `SwarmTaskOutcome`.
A successful outcome can include additional tasks.

This is a native Rust runtime API. The existing `run` API uses the same
scheduler with expansion disabled. Execution owners admit discovered work,
persist checkpoints, integrate changes, and verify the resulting artifact.

## Local CLI

The native `workflow` command runs an accepted JSON specification and records progress
in a local journal:

```bash
maestro workflow run workflow.json --json
maestro workflow status <run-id> --json
maestro workflow resume <run-id> --json
```

The specification must explicitly declare its model, allowed tools, write scopes, and
verification commands. For a Rust repository, this example permits changes
under `src` and checks the resulting revision with the repository's tests.
Replace `your-configured-model` with a model available through the existing
Maestro provider configuration.

```json
{
  "name": "repair-source",
  "version": "1",
  "steps": [
    {
      "id": "discover",
      "prompt": "Inspect src and propose focused repair tasks as followUpTasks.",
      "files": ["src"]
    },
    {
      "id": "summary",
      "prompt": "Summarize the completed repairs and any unresolved limitations.",
      "dependsOn": ["discover"]
    }
  ],
  "maxAgents": 500,
  "maxConcurrency": 16,
  "tokenBudget": 1000000,
  "model": {
    "model": "your-configured-model",
    "maxOutputTokens": 8192
  },
  "allowedTools": ["read", "edit", "write"],
  "writeScopes": ["src"],
  "verification": [
    {"command": "cargo", "args": ["test", "--locked"], "timeoutMs": 600000}
  ]
}
```

`maxAgents` counts initial and discovered tasks together. Keep the lifetime
task budget at or below the 512-task discovery ceiling. `maxConcurrency` limits
simultaneous callbacks and does not raise that ceiling. `tokenBudget` limits
the output-token allowance reserved for children; observed input and output
usage are recorded separately. It is not a total billing limit. Discovered
tasks inherit the accepted grants and cannot replace the model or verifier.
An empty tool list grants no tools, and an empty write scope grants no writes.
The summary task waits for discovered work through the expanded dependency
barrier. The owner then runs the declared verification commands.

Dependency context includes every child's identity, result digest, and a
bounded excerpt. The available excerpt space is shared across dependencies.
Use intermediate summary tasks when the final task needs more detail than
those excerpts can carry.

Resume uses the accepted specification and saved graph. A dispatch whose outcome was
not durably recorded remains indeterminate until it can be reconciled; a
`replaySafe` flag does not authorize repeating it. Local journal records do
not confer authority on a hosted Platform run.

## Discovery and verification

Start with `discover -> verify -> final`. When the discovery callback returns
500 additional tasks, the scheduler inserts them and makes `verify` depend on
all of them. A child can discover further work; that expansion also extends
its consumers' dependency barriers. `final` runs only after `verify` succeeds.

```rust
use maestro_swarm::{SwarmTask, SwarmTaskOutcome};

// The composing owner supplies the scheduler and its admitted child runner.
// Each callback receives context.task and context.dependency_results.
// Return a normal result with `result.into()`, or expand successful work:
fn discovered(result: maestro_swarm::TaskResult) -> SwarmTaskOutcome {
    SwarmTaskOutcome {
        result,
        follow_up_tasks: (0..500)
            .map(|index| SwarmTask::new(format!("item-{index}"), "Inspect item"))
            .collect(),
    }
}
```

Call `scheduler.run_expanding(503, callback)` for this graph: one discovery
callback, 500 item callbacks, one verification callback, and one final
callback. `SwarmConfig::max_concurrency` bounds simultaneous callbacks
independently of this total task budget. Budgets include already completed
tasks, so nested discovery cannot reset the allowance.

Expansion validates a replacement graph while holding the scheduler state
lock. Duplicate IDs, missing dependencies, cycles, additions marked as already
started, and budget exhaustion fail the source task without publishing any
of its additions. Adding prerequisites to an existing consumer that has
already started is also rejected.
Its original output remains available for diagnosis. Existing task identities
and results remain intact.

## File conflicts and unsuccessful work

`SwarmTask::files` supplies conservative file-scope scheduling hints. Tasks
claiming the same path, or a directory and a descendant, run serially.
Disjoint scopes can run concurrently. The scheduler compares candidates
against both running callbacks and other candidates in the same batch.
Glob, absolute, and unresolved parent paths overlap conservatively with other
declared scopes. An empty file list makes no claim.

These hints do not enforce write permissions, resolve symlink aliases, merge
patches, or detect incompatible API assumptions. The execution owner retains
workspace isolation and integration responsibility. A serialized callback
still needs to integrate against the appropriate revision.

A returned `TaskResult { success: false, .. }` fails the task and cannot
unlock its consumers. With `continue_on_failure`, unrelated work can finish,
but transitive consumers are skipped and the aggregate run remains failed.
Cancellation and failure retain the existing barrier that awaits admitted
callbacks before returning to the owner.

## Ownership and evidence

The caller is responsible for admitting follow-up tasks before returning
them; this API does not enforce that admission. The scheduler does not parse
model prose, authorize tools, allocate credentials, or accept a product
outcome. Its graph and dependency results remain an in-process cache.
Durable admission, effect receipts, and terminal acceptance remain Platform
responsibilities for hosted execution.

## Hosted execution

In Composer or Teams, an explicit `/workflow <goal>` request creates an
owner-authored discovery, verification, and final-result graph. Ordinary
messages retain their existing path. The command does not infer file-write
permissions from the goal or accept a model-supplied plan as authority.

Platform records the accepted plan and discovery admission with the work
item. The accepted plan grants discovery through the owner-supplied
`platform.discovery.v1` task tag. Child proposals are typed data: Platform
checks their plan version, task identities, scopes, and remaining budget
before passing additions to the scheduler. Older accepted plans remain
finite unless they contain an explicit discovery grant.

Hosted fan-out also remains subject to the existing native tool budget.
`DEX_COMPUTER_MAX_TOOL_CALLS_PER_TURN` defaults to four, and workspace policy
can narrow it further. Each child dispatch consumes one slot; tools used by
children consume additional slots. A 500-child workload therefore needs an
operator-configured budget and workspace policy that cover its entire graph
and tool use. The 512-task discovery ceiling does not grant that
budget. Concurrency is limited separately by the delegation policy.

The runtime stores snapshots and task receipts in the existing worker
checkpoint record. Writes require the current tenant-scoped lease and the
expected revision; a repeated event is accepted only when its evidence
matches. Ordinary worker checkpoint updates preserve the reserved swarm
state. A resumed run must match the durable accepted plan, even when no
swarm checkpoint has been written yet.

Before returning a child outcome, Platform records its full result,
discovered tasks, and receipts against the admitted dispatch. Recovery can
use that record if the process stops before the scheduler checkpoint commits.
A tool-effect marker alone cannot establish the child's result; unknown
effects remain pending reconciliation.

Scheduler completion does not settle the hosted parent by itself. Platform
checks the task receipts and retains its outer verification and terminal
acceptance gate. A parent awaiting verification remains pending. A completed
`/workflow` returns its final task's answer through the existing output checks.

## Checkpoints and interrupted work

`run_expanding_with_recovery` accepts `SwarmRecoveryHooks`. The persistence
hook receives a `SwarmSnapshot` before a callback starts and after its result
and accepted graph expansion are recorded. The owner must durably commit the
snapshot before returning from the hook. A persistence failure stops new
admissions and drains callbacks that already started.

Each snapshot contains the graph, results, in-flight dispatch identities,
task budget, configuration, and revision. `SwarmExecutor::from_snapshot`
validates this state before execution resumes. Completed callbacks remain
completed. An interrupted dispatch requires an explicit owner decision;
unknown effects remain indeterminate and cannot unlock dependent tasks.
Reconciliation of a completed discovery callback can include its result and
accepted follow-up tasks together.

Snapshot digests detect inconsistent serialization. The owner must still
authenticate the record and verify its tenant, admission contract, and lease.
A digest supplied by the runtime cannot establish authority.

## Integrating child changes

`maestro_workspace::integration` creates child worktrees at explicit Git
revisions. Integration builds a candidate commit in an isolated checkout,
then atomically advances workflow-owned aggregate and contribution refs.
Receipts identify the child, source and base commits, previous aggregate,
and resulting commit. Stable Git refs allow an interrupted receipt write to
be reconciled without applying the contribution again.

Conflicting patches, changed aggregate revisions, dirty protected checkouts,
and changes outside declared paths fail explicitly. This layer detects Git
conflicts; verifier commands must detect incompatible behavior or API
assumptions. Acceptance must reference the exact integrated commit that
passed verification. Integration does not publish a branch or alter the
user's checkout.

The public API regression test exercises 500 synthetic item callbacks with
16 execution slots and one final result. It checks dependency coverage and
actual peak concurrency. Other cases cover nested discovery, concurrent
budget exhaustion, invalid expansions, failed verification, file overlaps,
and single-execution admission. These tests do not measure LLM quality or
prove production execution of 500 agents.

```bash
cargo test -p maestro-swarm --locked
```

## Design references

[Claude dynamic workflows](https://code.claude.com/docs/en/workflows) keeps
branching and intermediate results outside the parent conversation, with
separate concurrency and total-agent limits.
[Factory Missions](https://docs.factory.ai/missions/planning) uses feature
work and validation checkpoints. This API applies bounded discovery and
verification barriers within Maestro's existing scheduler and ownership
boundaries. The local CLI inspection used Claude Code 2.1.267 and Droid
0.212.0; Claude authentication was unavailable during inspection.
