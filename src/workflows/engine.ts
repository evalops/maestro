/**
 * Workflow execution engine.
 *
 * Executes workflow definitions with:
 * - DAG-based dependency resolution
 * - Conditional step execution
 * - Variable interpolation
 * - Error handling and retries
 */

import type { AgentTool, AgentToolResult } from "../agent/types.js";
import { createLogger } from "../utils/logger.js";
import type {
	OnErrorAction,
	StepResult,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowExecutionOptions,
	WorkflowResult,
	WorkflowStatus,
	WorkflowStep,
} from "./types.js";

const logger = createLogger("workflow-engine");

/**
 * Topologically sort workflow steps based on dependencies.
 * Returns steps in execution order.
 */
function topologicalSort(steps: WorkflowStep[]): WorkflowStep[] {
	const stepMap = new Map(steps.map((s) => [s.id, s]));
	const visited = new Set<string>();
	const result: WorkflowStep[] = [];
	const visiting = new Set<string>();

	function visit(stepId: string): void {
		if (visited.has(stepId)) return;
		if (visiting.has(stepId)) {
			throw new Error(`Circular dependency detected involving step: ${stepId}`);
		}

		const step = stepMap.get(stepId);
		if (!step) {
			throw new Error(`Unknown step dependency: ${stepId}`);
		}

		visiting.add(stepId);

		for (const depId of step.depends_on ?? []) {
			visit(depId);
		}

		visiting.delete(stepId);
		visited.add(stepId);
		result.push(step);
	}

	for (const step of steps) {
		visit(step.id);
	}

	return result;
}

/**
 * Interpolate template strings with context values.
 *
 * Supports patterns like:
 * - ${steps.stepId.content.0.text}
 * - ${env.MY_VAR}
 * - ${vars.customVar}
 */
function interpolate(template: string, context: WorkflowContext): string {
	const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
	return template.replace(/\$\{([^}]+)\}/g, (match, path: string) => {
		const parts = path.trim().split(".");
		let value: unknown = context;

		for (const part of parts) {
			if (value === null || value === undefined) {
				return match; // Keep original if path doesn't resolve
			}
			if (typeof value === "object") {
				value = safeLookup(value, part, forbiddenKeys);
				if (value === undefined) {
					return match;
				}
			} else {
				return match;
			}
		}

		if (value === null || value === undefined) {
			return "";
		}
		return String(value);
	});
}

/**
 * Recursively interpolate all string values in params object.
 */
function interpolateParams(
	params: Record<string, unknown>,
	context: WorkflowContext,
): Record<string, unknown> {
	const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
	const result: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(params)) {
		if (typeof value === "string") {
			result[key] = interpolate(value, context);
		} else if (Array.isArray(value)) {
			result[key] = value.map((item) =>
				typeof item === "string"
					? interpolate(item, context)
					: typeof item === "object" && item !== null
						? interpolateParams(item as Record<string, unknown>, context)
						: item,
			);
		} else if (typeof value === "object" && value !== null) {
			result[key] = interpolateParams(
				value as Record<string, unknown>,
				context,
			);
		} else {
			result[key] = value;
		}
	}

	return result;
}

function safeLookup(
	obj: object,
	key: string,
	forbiddenKeys: Set<string>,
): unknown | undefined {
	if (forbiddenKeys.has(key)) {
		return undefined;
	}
	const record = obj as Record<string, unknown>;
	if (!Object.prototype.hasOwnProperty.call(record, key)) {
		return undefined;
	}
	return record[key];
}

/**
 * Evaluate a condition expression against the workflow context.
 *
 * Supports simple expressions:
 * - steps.stepId.success
 * - steps.stepId.error
 * - !steps.stepId.skipped
 * - env.DEBUG === "true"
 */
function evaluateCondition(
	condition: string,
	context: WorkflowContext,
): boolean {
	try {
		// Simple expression evaluation
		// Support: steps.id.success, steps.id.error, !expr, expr === value

		const trimmed = condition.trim();

		// Handle negation
		if (trimmed.startsWith("!")) {
			return !evaluateCondition(trimmed.slice(1), context);
		}

		// Handle equality comparison
		if (trimmed.includes("===")) {
			const [left, right] = trimmed.split("===").map((s) => s.trim());
			const leftValue = resolvePathValue(left, context);
			const rightValue =
				right.startsWith('"') || right.startsWith("'")
					? right.slice(1, -1)
					: right === "true"
						? true
						: right === "false"
							? false
							: right;
			return leftValue === rightValue;
		}

		// Handle inequality
		if (trimmed.includes("!==")) {
			const [left, right] = trimmed.split("!==").map((s) => s.trim());
			const leftValue = resolvePathValue(left, context);
			const rightValue =
				right.startsWith('"') || right.startsWith("'")
					? right.slice(1, -1)
					: right === "true"
						? true
						: right === "false"
							? false
							: right;
			return leftValue !== rightValue;
		}

		// Simple path resolution (truthy check)
		const value = resolvePathValue(trimmed, context);
		return Boolean(value);
	} catch (error) {
		logger.warn("Failed to evaluate condition", {
			condition,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

function resolvePathValue(path: string, context: WorkflowContext): unknown {
	const parts = path.split(".");
	let value: unknown = context;
	const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

	for (const part of parts) {
		if (value === null || value === undefined) {
			return undefined;
		}
		if (typeof value === "object") {
			value = safeLookup(value as Record<string, unknown>, part, forbiddenKeys);
			if (value === undefined) return undefined;
		} else {
			return undefined;
		}
	}

	return value;
}

/**
 * Execute a single workflow step with retry logic.
 */
async function executeStep(
	step: WorkflowStep,
	context: WorkflowContext,
	tools: Map<string, AgentTool>,
	options: WorkflowExecutionOptions,
	defaultOnError: OnErrorAction,
	defaultTimeout: number,
): Promise<StepResult> {
	const startTime = performance.now();

	// Check condition
	if (step.condition) {
		const shouldRun = evaluateCondition(step.condition, context);
		if (!shouldRun) {
			return {
				id: step.id,
				success: true,
				skipped: true,
				skipReason: `Condition not met: ${step.condition}`,
				duration: performance.now() - startTime,
			};
		}
	}

	// Check dependencies succeeded
	for (const depId of step.depends_on ?? []) {
		const depResult = context.steps[depId];
		if (!depResult) {
			return {
				id: step.id,
				success: false,
				error: `Dependency not found: ${depId}`,
				duration: performance.now() - startTime,
			};
		}
		if (!depResult.success && !depResult.skipped) {
			return {
				id: step.id,
				success: true,
				skipped: true,
				skipReason: `Dependency failed: ${depId}`,
				duration: performance.now() - startTime,
			};
		}
	}

	// Get tool
	const tool = tools.get(step.tool);
	if (!tool) {
		return {
			id: step.id,
			success: false,
			error: `Unknown tool: ${step.tool}`,
			duration: performance.now() - startTime,
		};
	}

	// Check approval if required
	if (step.requires_approval && options.onApprovalRequired) {
		const approved = await options.onApprovalRequired(step.id, step);
		if (!approved) {
			return {
				id: step.id,
				success: true,
				skipped: true,
				skipReason: "User denied approval",
				duration: performance.now() - startTime,
			};
		}
	}

	// Interpolate parameters
	const params = interpolateParams(step.params, context);

	// Execute with retry logic
	const onError = step.on_error ?? defaultOnError;
	const maxRetries = step.retry?.count ?? (onError === "retry" ? 3 : 0);
	const retryDelay = step.retry?.delay ?? 1000;
	const backoff = step.retry?.backoff ?? 2;
	const timeout = step.timeout ?? defaultTimeout;

	let lastError: string | undefined;
	let attempt = 0;

	while (attempt <= maxRetries) {
		try {
			options.onStepStart?.(step.id, step);

			// Create timeout promise
			const timeoutPromise =
				timeout > 0
					? new Promise<never>((_, reject) => {
							setTimeout(
								() => reject(new Error(`Step timed out after ${timeout}ms`)),
								timeout,
							);
						})
					: null;

			// Execute tool
			const executePromise = Promise.resolve(
				tool.execute(
					`workflow-${step.id}-${attempt}`,
					params,
					options.signal,
					{},
				),
			);

			const result: AgentToolResult = timeoutPromise
				? await Promise.race([executePromise, timeoutPromise])
				: await executePromise;

			if (result.isError) {
				throw new Error(
					result.content
						.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n") || "Tool execution failed",
				);
			}

			return {
				id: step.id,
				success: true,
				content: result.content.map((c) =>
					c.type === "text"
						? { type: "text" as const, text: c.text }
						: {
								type: "image" as const,
								data: "data" in c ? String(c.data) : "",
							},
				),
				details: result.details,
				duration: performance.now() - startTime,
			};
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			attempt++;

			if (attempt <= maxRetries) {
				const delay = retryDelay * backoff ** (attempt - 1);
				logger.info("Retrying step", {
					stepId: step.id,
					attempt,
					maxRetries,
					delay,
				});
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
	}

	return {
		id: step.id,
		success: false,
		error: lastError,
		duration: performance.now() - startTime,
	};
}

/**
 * Execute a workflow definition.
 */
export async function executeWorkflow(
	workflow: WorkflowDefinition,
	tools: Map<string, AgentTool>,
	options: WorkflowExecutionOptions = {},
): Promise<WorkflowResult> {
	const startTime = performance.now();

	logger.info("Starting workflow execution", {
		name: workflow.name,
		steps: workflow.steps.length,
		dryRun: options.dryRun,
	});

	// Initialize context
	const context: WorkflowContext = {
		steps: {},
		env: { ...workflow.env, ...options.env },
		vars: {},
	};

	// Sort steps by dependencies
	let sortedSteps: WorkflowStep[];
	try {
		sortedSteps = topologicalSort(workflow.steps);
	} catch (error) {
		return {
			name: workflow.name,
			status: "failed",
			steps: {},
			duration: performance.now() - startTime,
			error: error instanceof Error ? error.message : String(error),
		};
	}

	const defaultOnError = workflow.default_on_error ?? "stop";
	const defaultTimeout = workflow.default_timeout ?? 30000;

	let status: WorkflowStatus = "completed";
	let failedStep: string | undefined;
	let errorMessage: string | undefined;

	// Execute steps in order
	for (const step of sortedSteps) {
		// Check for cancellation
		if (options.signal?.aborted) {
			status = "cancelled";
			errorMessage = "Workflow cancelled";
			break;
		}

		if (options.dryRun) {
			// In dry run, just record what would happen
			context.steps[step.id] = {
				id: step.id,
				success: true,
				skipped: true,
				skipReason: "Dry run - step not executed",
				duration: 0,
			};
			continue;
		}

		const result = await executeStep(
			step,
			context,
			tools,
			options,
			defaultOnError,
			defaultTimeout,
		);

		context.steps[step.id] = result;
		options.onStepComplete?.(step.id, result);

		if (!result.success && !result.skipped) {
			const onError = step.on_error ?? defaultOnError;
			if (onError === "stop") {
				status = "failed";
				failedStep = step.id;
				errorMessage = result.error;
				break;
			}
			// continue: just log and proceed
			logger.warn("Step failed but continuing", {
				stepId: step.id,
				error: result.error,
			});
		}
	}

	const duration = performance.now() - startTime;

	logger.info("Workflow execution complete", {
		name: workflow.name,
		status,
		duration,
		stepsCompleted: Object.keys(context.steps).length,
	});

	return {
		name: workflow.name,
		status,
		steps: context.steps,
		duration,
		error: errorMessage,
		failedStep,
	};
}

/**
 * Validate a workflow definition without executing it.
 */
export function validateWorkflow(
	workflow: WorkflowDefinition,
	availableTools: Set<string>,
): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!workflow.name) {
		errors.push("Workflow must have a name");
	}

	if (!workflow.steps || workflow.steps.length === 0) {
		errors.push("Workflow must have at least one step");
	}

	const stepIds = new Set<string>();
	for (const step of workflow.steps) {
		if (!step.id) {
			errors.push("Each step must have an id");
			continue;
		}

		if (stepIds.has(step.id)) {
			errors.push(`Duplicate step id: ${step.id}`);
		}
		stepIds.add(step.id);

		if (!step.tool) {
			errors.push(`Step ${step.id}: tool is required`);
		} else if (!availableTools.has(step.tool)) {
			errors.push(`Step ${step.id}: unknown tool "${step.tool}"`);
		}

		for (const depId of step.depends_on ?? []) {
			if (!stepIds.has(depId) && !workflow.steps.some((s) => s.id === depId)) {
				errors.push(
					`Step ${step.id}: depends_on references unknown step "${depId}"`,
				);
			}
		}
	}

	// Check for circular dependencies
	try {
		topologicalSort(workflow.steps);
	} catch (error) {
		errors.push(
			error instanceof Error ? error.message : "Circular dependency detected",
		);
	}

	return {
		valid: errors.length === 0,
		errors,
	};
}
