# Delegation Prompt Contract

Maestro-owned subagent dispatch should pass a `DelegationPrompt` object through
`formatDelegation` before invoking another agent process. The contract gives each
handoff the same shape:

- `goal`: the outcome the child agent is working toward
- `context`: the parent run, role, and constraints the child needs
- `task`: the concrete work to perform
- `evidence`: files, issues, prior results, or artifacts the child should inspect
- `validation`: checks the child should run or evidence it should cite
- `stoppingCondition`: the point where the child should stop and report back

Example:

```ts
import { formatDelegation, type DelegationPrompt } from "@evalops/contracts";

const prompt: DelegationPrompt = {
  goal: "Complete swarm task task-1 as teammate Alpha.",
  context: "You are working from plan.md in a parent swarm run.",
  task: "Add the missing retry test for the hosted runner.",
  evidence: ["src/remote-runner/client.ts", "test/remote-runner/client.test.ts"],
  validation: "Run the focused remote runner test.",
  stoppingCondition: "Stop after the test passes and summarize changed files.",
};

const markdown = formatDelegation(prompt);
```

The parent may add a short role preface, but the delegated task body should keep
the six headings intact so audits, prompt fixtures, and future evals can compare
delegations across swarm, Oracle, and GitHub agent workers.
