/**
 * Slack Agent Tools
 */

import type { Executor } from "../sandbox.js";
import { attachTool, setUploadFunction } from "./attach.js";
import { createBashTool } from "./bash.js";
import { createEditTool } from "./edit.js";
import { createReadTool } from "./read.js";
import { createStatusTool } from "./status.js";
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

export interface CreateToolsOptions {
	/** Container name for Docker environments (enables container health monitoring) */
	containerName?: string;
}

export function createSlackAgentTools(
	executor: Executor,
	options?: CreateToolsOptions,
): AgentTool[] {
	return [
		createReadTool(executor),
		createBashTool(executor),
		createEditTool(executor),
		createWriteTool(executor),
		createStatusTool(executor, options?.containerName),
		attachTool,
	];
}

export {
	createBashTool,
	createReadTool,
	createWriteTool,
	createEditTool,
	createStatusTool,
	attachTool,
	setUploadFunction,
};
