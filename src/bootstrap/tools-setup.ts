/**
 * Tools & Sandbox Setup - Tool filtering and sandbox initialization.
 *
 * Extracts tool registry filtering and sandbox creation from main.ts Phase 10.
 *
 * @module bootstrap/tools-setup
 */

import chalk from "chalk";
import type { AgentTool } from "../agent/types.js";
import {
	type SandboxMode,
	createSandbox,
	disposeSandbox,
} from "../sandbox/index.js";
import { codingTools, filterTools, toolRegistry } from "../tools/index.js";
import { loadInlineTools } from "../tools/inline-tools.js";

export interface ToolsSetupResult {
	/** All tools (base + inline) */
	allTools: AgentTool[];
	/** Base tools after filtering (used for MCP merges) */
	baseTools: AgentTool[];
	/** Sandbox instance if requested */
	sandbox: ReturnType<typeof createSandbox> extends Promise<infer T>
		? T
		: never | undefined;
	/** Resolved sandbox mode */
	sandboxMode: SandboxMode | undefined;
	/** Cleanup function for sandbox (call on process exit) */
	disposeSandbox?: () => Promise<void>;
}

/**
 * Build the tool set and optionally create a sandbox.
 *
 * @throws Error if --tools filter matches no tools
 */
export async function createToolsAndSandbox(params: {
	parsedTools?: string[];
	parsedSandbox?: string;
	cwd: string;
}): Promise<ToolsSetupResult> {
	const { parsedTools, parsedSandbox, cwd } = params;

	// Apply --tools filter if user specified a subset
	let baseTools = codingTools;
	if (parsedTools && parsedTools.length > 0) {
		const filteredTools = filterTools(parsedTools);
		if (filteredTools.length === 0) {
			throw new Error(
				`No valid tools matched --tools filter: ${parsedTools.join(", ")}. ` +
					`Available tools: ${Object.keys(toolRegistry).sort().join(", ")}`,
			);
		}
		baseTools = filteredTools;
		console.log(
			chalk.dim(
				`Tools restricted to: ${filteredTools.map((t) => t.name).join(", ")}`,
			),
		);
	}

	// Load inline tools from .composer/tools.json and ~/.composer/tools.json
	const inlineTools = loadInlineTools();
	const allTools = [...baseTools, ...inlineTools];

	// Create sandbox for isolated tool execution if requested
	const sandboxMode = (parsedSandbox ?? process.env.COMPOSER_SANDBOX_MODE) as
		| SandboxMode
		| undefined;
	const sandbox = sandboxMode
		? await createSandbox({ mode: sandboxMode, cwd })
		: undefined;

	const cleanupSandbox = sandbox
		? async () => {
				await disposeSandbox(sandbox);
			}
		: undefined;

	return {
		allTools,
		baseTools,
		sandbox,
		sandboxMode,
		disposeSandbox: cleanupSandbox,
	};
}
