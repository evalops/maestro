/**
 * CustomCommandsController - Handles custom prompts and commands
 *
 * Manages user-defined templates loaded from the filesystem:
 * - /prompts command: List and execute prompt templates
 * - /commands command: List and run custom command templates
 *
 * Templates are loaded from:
 * - ~/.maestro/prompts/ and .maestro/prompts/ for prompts
 * - ~/.maestro/commands/ and .maestro/commands/ for commands
 */

import {
	findPrompt,
	formatPromptListItem,
	getPromptUsageHint,
	loadCommandCatalog,
	loadPrompts,
	parseCommandArgs,
	parsePromptArgs,
	renderCommandPrompt,
	renderPrompt,
	validateCommandArgs,
	validatePromptArgs,
} from "../../commands/catalog.js";
import type { CommandExecutionContext } from "../commands/types.js";

export interface CustomCommandsControllerCallbacks {
	/** Add text content to chat container */
	addContent: (text: string) => void;
	/** Set editor text */
	setEditorText: (text: string) => void;
	/** Show toast notification */
	showToast: (message: string, type: "info" | "success") => void;
	/** Request UI render */
	requestRender: () => void;
}

export interface CustomCommandsControllerOptions {
	callbacks: CustomCommandsControllerCallbacks;
	/** Working directory for loading catalogs */
	cwd: string;
}

export class CustomCommandsController {
	private readonly callbacks: CustomCommandsControllerCallbacks;
	private readonly cwd: string;

	constructor(options: CustomCommandsControllerOptions) {
		this.callbacks = options.callbacks;
		this.cwd = options.cwd;
	}

	/**
	 * Handle /prompts command
	 */
	handlePromptsCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim();
		const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
		const prompts = loadPrompts(this.cwd);

		// No args or "list" - show available prompts
		if (!action || action === "list") {
			if (prompts.length === 0) {
				context.showInfo(
					"No prompts found. Add .md files to ~/.maestro/prompts/ or .maestro/prompts/",
				);
				return;
			}
			const lines = prompts.map((p) => `• ${formatPromptListItem(p)}`);
			this.callbacks.addContent(
				`Prompts (${prompts.length}):\n${lines.join("\n")}`,
			);
			this.callbacks.requestRender();
			return;
		}

		// Find the prompt by name
		const promptName = action;
		const prompt = findPrompt(prompts, promptName);
		if (!prompt) {
			const suggestions =
				prompts.length > 0
					? `Available: ${prompts.map((p) => p.name).join(", ")}`
					: "No prompts available.";
			context.showError(`Prompt "${promptName}" not found. ${suggestions}`);
			return;
		}

		// Parse and validate arguments
		const argsString = rest.join(" ");
		const args = parsePromptArgs(argsString);
		const validation = validatePromptArgs(prompt, args);
		if (validation) {
			context.showError(`${validation}\nUsage: ${getPromptUsageHint(prompt)}`);
			return;
		}

		// Render the prompt and insert into editor
		const rendered = renderPrompt(prompt, args);
		this.callbacks.setEditorText(rendered);
		this.callbacks.showToast(
			`Inserted prompt "${prompt.name}". Edit and submit.`,
			"info",
		);
		this.callbacks.requestRender();
	}

	/**
	 * Handle /commands command
	 */
	handleCommandsCommand(context: CommandExecutionContext): void {
		const arg = context.argumentText.trim();
		const [action, ...rest] = arg.split(/\s+/).filter(Boolean);
		const catalog = loadCommandCatalog(this.cwd);

		if (!action || action === "list") {
			if (catalog.length === 0) {
				context.showInfo(
					"No commands found in ~/.maestro/commands or .maestro/commands.",
				);
				return;
			}
			const lines = catalog.map(
				(cmd) =>
					`• ${cmd.name} – ${cmd.description ?? "(no description)"} (${cmd.source})`,
			);
			this.callbacks.addContent(lines.join("\n"));
			this.callbacks.requestRender();
			return;
		}

		if (action !== "run") {
			context.showError(
				"Usage: /commands list | /commands run <name> arg=value ...",
			);
			return;
		}

		const name = rest.shift();
		if (!name) {
			context.showError("Specify a command name to run.");
			return;
		}

		const cmd = catalog.find((c) => c.name === name);
		if (!cmd) {
			context.showError(`Command ${name} not found.`);
			return;
		}

		const args = parseCommandArgs(rest);
		const validation = validateCommandArgs(cmd, args);
		if (validation) {
			context.showError(validation);
			return;
		}

		const prompt = renderCommandPrompt(cmd, args);
		this.callbacks.setEditorText(prompt);
		this.callbacks.showToast(
			`Inserted command "${cmd.name}" into Maestro. Edit then submit.`,
			"info",
		);
		this.callbacks.requestRender();
	}
}

export function createCustomCommandsController(
	options: CustomCommandsControllerOptions,
): CustomCommandsController {
	return new CustomCommandsController(options);
}
