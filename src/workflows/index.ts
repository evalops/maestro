/**
 * Workflow DSL module.
 *
 * Provides declarative multi-step tool execution pipelines with:
 * - YAML/JSON workflow definitions
 * - DAG-based dependency resolution
 * - Conditional step execution
 * - Variable interpolation
 * - Error handling and retries
 *
 * @example
 * ```typescript
 * import { loadWorkflows, executeWorkflow } from "./workflows";
 *
 * const workflows = loadWorkflows(process.cwd());
 * const workflow = workflows.get("setup-project");
 *
 * const result = await executeWorkflow(workflow, toolRegistry, {
 *   onStepComplete: (stepId, result) => {
 *     console.log(`Step ${stepId}: ${result.success ? "OK" : "FAILED"}`);
 *   }
 * });
 * ```
 */

export {
	executeWorkflow,
	validateWorkflow,
} from "./engine.js";

export {
	loadWorkflows,
	loadWorkflowFile,
	getWorkflow,
	listWorkflowNames,
	hasWorkflowsDirectory,
	ensureWorkflowsDirectory,
} from "./loader.js";

export type {
	WorkflowDefinition,
	WorkflowStep,
	WorkflowContext,
	WorkflowResult,
	WorkflowExecutionOptions,
	WorkflowStatus,
	StepResult,
	OnErrorAction,
	RetryConfig,
} from "./types.js";
