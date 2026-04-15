/**
 * Workflow DSL type definitions.
 *
 * Workflows are declarative multi-step tool execution pipelines
 * with conditional logic, dependencies, and variable passing.
 */

export type OnErrorAction = "continue" | "stop" | "retry";

export interface RetryConfig {
	/** Maximum number of retry attempts */
	count: number;
	/** Initial delay between retries in ms */
	delay?: number;
	/** Exponential backoff multiplier */
	backoff?: number;
}

export interface WorkflowStepParams {
	[key: string]: unknown;
}

export interface WorkflowStep {
	/** Unique identifier for this step */
	id: string;
	/** Tool to execute (e.g., "read", "write", "bash") */
	tool: string;
	/** Tool parameters - supports template interpolation */
	params: WorkflowStepParams;
	/** Optional description for documentation */
	description?: string;
	/** Condition expression - step runs only if evaluates to true */
	condition?: string;
	/** Step IDs that must complete before this step runs */
	depends_on?: string[];
	/** Behavior when this step fails */
	on_error?: OnErrorAction;
	/** Retry configuration for transient failures */
	retry?: RetryConfig;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Whether this step requires user approval before execution */
	requires_approval?: boolean;
}

export interface WorkflowDefinition {
	/** Unique workflow name */
	name: string;
	/** Human-readable description */
	description?: string;
	/** Workflow version for compatibility */
	version?: string;
	/** Workflow steps in declaration order */
	steps: WorkflowStep[];
	/** Environment variables available to all steps */
	env?: Record<string, string>;
	/** Default on_error behavior for all steps */
	default_on_error?: OnErrorAction;
	/** Default timeout for all steps in milliseconds */
	default_timeout?: number;
}

export interface StepResult {
	/** Step ID */
	id: string;
	/** Whether the step succeeded */
	success: boolean;
	/** Error message if failed */
	error?: string;
	/** Step output content */
	content?: Array<
		{ type: "text"; text: string } | { type: "image"; data: string }
	>;
	/** Structured details from tool execution */
	details?: unknown;
	/** Execution duration in milliseconds */
	duration: number;
	/** Whether step was skipped due to condition */
	skipped?: boolean;
	/** Skip reason if skipped */
	skipReason?: string;
}

export interface WorkflowContext {
	/** Results from completed steps, keyed by step ID */
	steps: Record<string, StepResult>;
	/** Environment variables */
	env: Record<string, string>;
	/** Workflow-level variables set during execution */
	vars: Record<string, unknown>;
}

export type WorkflowStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "cancelled";

export interface WorkflowResult {
	/** Workflow name */
	name: string;
	/** Overall status */
	status: WorkflowStatus;
	/** Results for each step */
	steps: Record<string, StepResult>;
	/** Total execution duration in milliseconds */
	duration: number;
	/** Error message if workflow failed */
	error?: string;
	/** ID of the step that caused failure */
	failedStep?: string;
}

export interface WorkflowExecutionOptions {
	/** If true, validate and report what would happen without executing */
	dryRun?: boolean;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Initial environment variables */
	env?: Record<string, string>;
	/** Callback for step completion events */
	onStepComplete?: (stepId: string, result: StepResult) => void;
	/** Callback for step start events */
	onStepStart?: (stepId: string, step: WorkflowStep) => void;
	/** Callback for approval requests */
	onApprovalRequired?: (stepId: string, step: WorkflowStep) => Promise<boolean>;
}
