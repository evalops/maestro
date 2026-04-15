/**
 * Swarm Mode - Parallel Agent Execution
 *
 * This module enables parallel execution of multiple agent instances
 * (teammates) to implement plans collaboratively. Inspired by Claude Code's
 * swarm feature.
 *
 * ## Architecture
 *
 * The swarm system consists of:
 * - **Executor**: Manages the lifecycle of teammates and task distribution
 * - **Plan Parser**: Extracts tasks from markdown plan files
 * - **Teammates**: Individual agent subprocesses working on tasks
 *
 * ## Usage
 *
 * ```typescript
 * import { executeSwarm, parsePlanFile } from "./swarm";
 *
 * const plan = parsePlanFile(".maestro/plans/my-plan.md");
 * const result = await executeSwarm({
 *   teammateCount: 3,
 *   planFile: ".maestro/plans/my-plan.md",
 *   tasks: plan.tasks,
 *   cwd: process.cwd(),
 * });
 * ```
 *
 * ## Integration with Plan Mode
 *
 * Swarms are launched via the `exitPlanMode` function with `launchSwarm: true`:
 *
 * ```typescript
 * exitPlanMode({
 *   launchSwarm: true,
 *   teammateCount: 3,
 * });
 * ```
 */

export { SwarmExecutor, executeSwarm } from "./executor.js";
export {
	parsePlanFile,
	parsePlanContent,
	generatePlanTemplate,
	markTasksComplete,
} from "./plan-parser.js";
export type {
	SwarmConfig,
	SwarmState,
	SwarmTeammate,
	SwarmTask,
	SwarmEvent,
	SwarmEventHandler,
	SwarmStatus,
	TeammateStatus,
	ParsedPlan,
} from "./types.js";
