/**
 * Workflow command handlers for TUI.
 *
 * Provides /workflow slash command functionality:
 * - /workflow list - List available workflows
 * - /workflow run <name> - Execute a workflow
 * - /workflow validate <name> - Validate without executing
 * - /workflow show <name> - Show workflow details
 */

import chalk from "chalk";
import type { AgentTool } from "../../agent/types.js";
import {
	executeWorkflow,
	getWorkflow,
	hasWorkflowsDirectory,
	listWorkflowNames,
	validateWorkflow,
} from "../../workflows/index.js";
import type { WorkflowStep } from "../../workflows/types.js";

export interface WorkflowRenderContext {
	rawInput: string;
	cwd: string;
	tools: Map<string, AgentTool>;
	addContent(content: string): void;
	showError(message: string): void;
	showInfo(message: string): void;
	showSuccess(message: string): void;
	requestRender(): void;
}

export async function handleWorkflowCommand(
	ctx: WorkflowRenderContext,
): Promise<void> {
	const args = ctx.rawInput.replace(/^\/workflow\s*/, "").trim();
	const parts = args.split(/\s+/);
	const subcommand = parts[0]?.toLowerCase() || "";

	switch (subcommand) {
		case "list":
		case "ls":
			handleWorkflowList(ctx);
			break;
		case "run":
		case "exec":
			await handleWorkflowRun(parts.slice(1), ctx);
			break;
		case "validate":
		case "check":
			handleWorkflowValidate(parts.slice(1), ctx);
			break;
		case "show":
		case "info":
			handleWorkflowShow(parts.slice(1), ctx);
			break;
		default:
			handleWorkflowHelp(ctx);
	}
}

function handleWorkflowList(ctx: WorkflowRenderContext): void {
	const lines: string[] = ["Workflows", ""];

	if (!hasWorkflowsDirectory(ctx.cwd)) {
		lines.push(
			"No workflows directory found.",
			"",
			"Create workflows in .composer/workflows/:",
			"",
			"  .composer/workflows/my-workflow.yaml",
			"",
			"See /workflow help for more information.",
		);
		ctx.addContent(lines.join("\n"));
		ctx.requestRender();
		return;
	}

	const names = listWorkflowNames(ctx.cwd);

	if (names.length === 0) {
		lines.push(
			"No workflows defined.",
			"",
			"Create a workflow file in .composer/workflows/",
		);
	} else {
		lines.push(`Found ${names.length} workflow(s):`, "");
		for (const name of names) {
			const workflow = getWorkflow(ctx.cwd, name);
			const stepCount = workflow?.steps?.length ?? 0;
			const desc = workflow?.description
				? chalk.dim(` - ${workflow.description}`)
				: "";
			lines.push(`  ${chalk.cyan(name)} (${stepCount} steps)${desc}`);
		}
		lines.push("", chalk.dim("Run with: /workflow run <name>"));
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

async function handleWorkflowRun(
	args: string[],
	ctx: WorkflowRenderContext,
): Promise<void> {
	const workflowName = args[0];

	if (!workflowName) {
		ctx.showError("Usage: /workflow run <name>");
		return;
	}

	const workflow = getWorkflow(ctx.cwd, workflowName);
	if (!workflow) {
		ctx.showError(`Workflow not found: ${workflowName}`);
		return;
	}

	// Validate first
	const validation = validateWorkflow(workflow, new Set(ctx.tools.keys()));
	if (!validation.valid) {
		ctx.showError(
			`Workflow validation failed:\n${validation.errors.join("\n")}`,
		);
		return;
	}

	const lines: string[] = [
		`Running workflow: ${chalk.cyan(workflow.name)}`,
		"",
	];
	ctx.addContent(lines.join("\n"));
	ctx.requestRender();

	const startTime = Date.now();

	try {
		const result = await executeWorkflow(workflow, ctx.tools, {
			onStepStart: (stepId, step) => {
				ctx.addContent(`  ${chalk.yellow("▶")} ${stepId}: ${step.tool}...`);
				ctx.requestRender();
			},
			onStepComplete: (stepId, stepResult) => {
				const icon = stepResult.success
					? stepResult.skipped
						? chalk.dim("○")
						: chalk.green("✓")
					: chalk.red("✗");
				const status = stepResult.skipped
					? chalk.dim(`skipped: ${stepResult.skipReason}`)
					: stepResult.success
						? chalk.green("done")
						: chalk.red(stepResult.error || "failed");
				ctx.addContent(`  ${icon} ${stepId}: ${status}`);
				ctx.requestRender();
			},
		});

		ctx.addContent("");

		if (result.status === "completed") {
			const successCount = Object.values(result.steps).filter(
				(s) => s.success && !s.skipped,
			).length;
			const skippedCount = Object.values(result.steps).filter(
				(s) => s.skipped,
			).length;
			ctx.showSuccess(
				`Workflow completed in ${Math.round(result.duration)}ms (${successCount} executed, ${skippedCount} skipped)`,
			);
		} else if (result.status === "failed") {
			ctx.showError(
				`Workflow failed at step ${result.failedStep}: ${result.error}`,
			);
		} else if (result.status === "cancelled") {
			ctx.showInfo("Workflow cancelled");
		}
	} catch (error) {
		ctx.showError(
			`Workflow execution error: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function handleWorkflowValidate(
	args: string[],
	ctx: WorkflowRenderContext,
): void {
	const workflowName = args[0];

	if (!workflowName) {
		ctx.showError("Usage: /workflow validate <name>");
		return;
	}

	const workflow = getWorkflow(ctx.cwd, workflowName);
	if (!workflow) {
		ctx.showError(`Workflow not found: ${workflowName}`);
		return;
	}

	const validation = validateWorkflow(workflow, new Set(ctx.tools.keys()));

	if (validation.valid) {
		ctx.showSuccess(`Workflow "${workflowName}" is valid`);
	} else {
		const lines = [
			chalk.red(
				`Workflow "${workflowName}" has ${validation.errors.length} error(s):`,
			),
			"",
			...validation.errors.map((e) => `  ${chalk.red("•")} ${e}`),
		];
		ctx.addContent(lines.join("\n"));
		ctx.requestRender();
	}
}

function handleWorkflowShow(args: string[], ctx: WorkflowRenderContext): void {
	const workflowName = args[0];

	if (!workflowName) {
		ctx.showError("Usage: /workflow show <name>");
		return;
	}

	const workflow = getWorkflow(ctx.cwd, workflowName);
	if (!workflow) {
		ctx.showError(`Workflow not found: ${workflowName}`);
		return;
	}

	const lines: string[] = [`Workflow: ${chalk.cyan(workflow.name)}`, ""];

	if (workflow.description) {
		lines.push(workflow.description, "");
	}

	if (workflow.version) {
		lines.push(`Version: ${workflow.version}`, "");
	}

	lines.push(`Steps (${workflow.steps.length}):`, "");

	for (const step of workflow.steps) {
		const deps =
			step.depends_on && step.depends_on.length > 0
				? chalk.dim(` [after: ${step.depends_on.join(", ")}]`)
				: "";
		const cond = step.condition ? chalk.dim(` [if: ${step.condition}]`) : "";

		lines.push(`  ${chalk.yellow(step.id)}: ${step.tool}${deps}${cond}`);

		if (step.description) {
			lines.push(`    ${chalk.dim(step.description)}`);
		}

		// Show key params
		const paramKeys = Object.keys(step.params).slice(0, 3);
		if (paramKeys.length > 0) {
			const paramSummary = paramKeys
				.map((k) => {
					const v = step.params[k];
					const vs = typeof v === "string" ? v.slice(0, 30) : JSON.stringify(v);
					return `${k}=${vs}${typeof v === "string" && v.length > 30 ? "..." : ""}`;
				})
				.join(", ");
			lines.push(`    ${chalk.dim(paramSummary)}`);
		}
	}

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}

function handleWorkflowHelp(ctx: WorkflowRenderContext): void {
	const lines = [
		"Workflow Commands",
		"",
		"  /workflow list              List available workflows",
		"  /workflow run <name>        Execute a workflow",
		"  /workflow validate <name>   Validate a workflow",
		"  /workflow show <name>       Show workflow details",
		"",
		"Workflows are defined in .composer/workflows/*.yaml",
		"",
		"Example workflow:",
		"",
		chalk.dim("  # .composer/workflows/setup.yaml"),
		chalk.dim("  name: setup-project"),
		chalk.dim("  description: Initialize project"),
		chalk.dim("  steps:"),
		chalk.dim("    - id: check-pkg"),
		chalk.dim("      tool: read"),
		chalk.dim("      params:"),
		chalk.dim("        path: package.json"),
		chalk.dim("      on_error: continue"),
		chalk.dim(""),
		chalk.dim("    - id: init"),
		chalk.dim("      tool: bash"),
		chalk.dim('      condition: "steps.check-pkg.error"'),
		chalk.dim("      params:"),
		chalk.dim("        command: npm init -y"),
	];

	ctx.addContent(lines.join("\n"));
	ctx.requestRender();
}
