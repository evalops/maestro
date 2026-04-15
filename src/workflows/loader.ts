/**
 * Workflow definition loader.
 *
 * Loads workflow definitions from:
 * - .maestro/workflows/*.yaml
 * - .maestro/workflows/*.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createLogger } from "../utils/logger.js";
import type { WorkflowDefinition } from "./types.js";

const logger = createLogger("workflow-loader");

const WORKFLOW_DIR = ".maestro/workflows";

/**
 * Load a workflow definition from a file.
 */
export function loadWorkflowFile(filePath: string): WorkflowDefinition | null {
	try {
		const content = readFileSync(filePath, "utf-8");

		if (filePath.endsWith(".yaml") || filePath.endsWith(".yml")) {
			return parseYaml(content) as WorkflowDefinition;
		}

		if (filePath.endsWith(".json")) {
			return JSON.parse(content) as WorkflowDefinition;
		}

		logger.warn("Unknown workflow file format", { filePath });
		return null;
	} catch (error) {
		logger.error(
			"Failed to load workflow file",
			error instanceof Error ? error : new Error(String(error)),
			{ filePath },
		);
		return null;
	}
}

/**
 * Load all workflows from the project's .maestro/workflows directory.
 */
export function loadWorkflows(cwd: string): Map<string, WorkflowDefinition> {
	const workflows = new Map<string, WorkflowDefinition>();
	const workflowDir = join(cwd, WORKFLOW_DIR);

	if (!existsSync(workflowDir)) {
		return workflows;
	}

	try {
		const files = readdirSync(workflowDir);

		for (const file of files) {
			if (
				!file.endsWith(".yaml") &&
				!file.endsWith(".yml") &&
				!file.endsWith(".json")
			) {
				continue;
			}

			const filePath = join(workflowDir, file);
			const workflow = loadWorkflowFile(filePath);

			if (workflow?.name) {
				workflows.set(workflow.name, workflow);
				logger.debug("Loaded workflow", {
					name: workflow.name,
					steps: workflow.steps?.length ?? 0,
				});
			}
		}
	} catch (error) {
		logger.error(
			"Failed to read workflows directory",
			error instanceof Error ? error : new Error(String(error)),
			{ workflowDir },
		);
	}

	return workflows;
}

/**
 * Get a specific workflow by name.
 */
export function getWorkflow(
	cwd: string,
	name: string,
): WorkflowDefinition | null {
	const workflows = loadWorkflows(cwd);
	return workflows.get(name) ?? null;
}

/**
 * List all available workflow names.
 */
export function listWorkflowNames(cwd: string): string[] {
	const workflows = loadWorkflows(cwd);
	return Array.from(workflows.keys()).sort();
}

/**
 * Check if workflows directory exists.
 */
export function hasWorkflowsDirectory(cwd: string): boolean {
	return existsSync(join(cwd, WORKFLOW_DIR));
}

/**
 * Create the workflows directory if it doesn't exist.
 */
export function ensureWorkflowsDirectory(cwd: string): string {
	const workflowDir = join(cwd, WORKFLOW_DIR);

	if (!existsSync(workflowDir)) {
		mkdirSync(workflowDir, { recursive: true });
	}

	return workflowDir;
}
