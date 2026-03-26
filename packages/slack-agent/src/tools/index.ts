/**
 * Slack Agent Tools
 */

import type { Executor } from "../sandbox.js";
import { attachTool, setUploadFunction } from "./attach.js";
import { type ApprovalCallback, createBashTool } from "./bash.js";
import { createBuildDashboardTool } from "./build-dashboard.js";
import { createLiveDashboardTool } from "./create-live-dashboard.js";
import { createDeployTool } from "./deploy.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { type ScheduleToolOptions, createScheduleTool } from "./schedule.js";
import { createStatusTool } from "./status.js";
import { createWorkflowTool } from "./workflow.js";
import { createWriteTool } from "./write.js";

export interface AgentTool<T = unknown> {
	name: string;
	label: string;
	description: string;
	parameters: T;
	execute: (
		toolCallId: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<{
		content: Array<{
			type: string;
			text?: string;
			data?: string;
			mimeType?: string;
		}>;
		details?: unknown;
	}>;
}

export interface DeployDetails {
	url: string;
	port: number;
	directory: string;
	expiresIn?: number;
	spec?: import("../dashboard/types.js").DashboardSpec;
}

export interface CreateToolsOptions {
	/** Container name for Docker environments (enables container health monitoring) */
	containerName?: string;
	/** Callback for requesting approval of destructive commands */
	onApprovalNeeded?: ApprovalCallback;
	/** Options for the schedule tool (if not provided, schedule tool is not included) */
	scheduleOptions?: ScheduleToolOptions;
	/** Additional tools to include (e.g., from connectors) */
	extraTools?: AgentTool[];
	/** Called after a successful deploy with the deploy details */
	onDeploy?: (label: string, details: DeployDetails) => void;
}

export function createSlackAgentTools(
	executor: Executor,
	options?: CreateToolsOptions,
): AgentTool[] {
	const tools: AgentTool[] = [
		createReadTool(executor),
		createBashTool(executor, { onApprovalNeeded: options?.onApprovalNeeded }),
		createEditTool(executor),
		createWriteTool(executor),
		createStatusTool(executor, options?.containerName),
		attachTool,
		createDeployTool(executor, options?.onDeploy),
		createBuildDashboardTool(executor, options?.onDeploy),
	];

	// Add schedule tool if options are provided
	if (options?.scheduleOptions) {
		tools.push(createScheduleTool(options.scheduleOptions));
	}

	// Add connector tools or other extras
	if (options?.extraTools?.length) {
		tools.push(...options.extraTools);
	}

	// Add workflow tool (needs reference to all available tools)
	tools.push(createWorkflowTool(tools));

	return tools;
}

export {
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createStatusTool,
	createScheduleTool,
	createDeployTool,
	createBuildDashboardTool,
	createLiveDashboardTool,
	createWorkflowTool,
	attachTool,
	setUploadFunction,
};

export type { ScheduleToolOptions };
