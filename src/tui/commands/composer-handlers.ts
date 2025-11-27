import { composerManager, loadComposers } from "../../composers/index.js";

export interface ComposerRenderContext {
	rawInput: string;
	cwd: string;
	addContent(content: string): void;
	requestRender(): void;
}

export function handleComposerCommand(renderCtx: ComposerRenderContext): void {
	const args = renderCtx.rawInput.replace(/^\/composer\s*/, "").trim();
	const parts = args.split(/\s+/);
	const subcommand = parts[0]?.toLowerCase() || "";
	const composerName = parts.slice(1).join(" ");

	const lines: string[] = [];
	const composers = loadComposers(renderCtx.cwd);
	const state = composerManager.getState();

	if (subcommand === "activate" && composerName) {
		const success = composerManager.activate(composerName, renderCtx.cwd);
		if (success) {
			const newState = composerManager.getState();
			lines.push(`Activated composer: ${newState.active?.name}`);
			lines.push(`Description: ${newState.active?.description}`);
			if (newState.active?.tools?.length) {
				lines.push(`Tools restricted to: ${newState.active.tools.join(", ")}`);
			}
			if (newState.active?.model) {
				lines.push(`Model: ${newState.active.model}`);
			}
		} else {
			lines.push(`Failed to activate composer '${composerName}'.`);
			lines.push("Use /composer list to see available composers.");
		}
	} else if (subcommand === "deactivate") {
		if (state.active) {
			const name = state.active.name;
			composerManager.deactivate();
			lines.push(`Deactivated composer: ${name}`);
			lines.push("Restored to default configuration.");
		} else {
			lines.push("No composer is currently active.");
		}
	} else if (subcommand === "list" || subcommand === "") {
		// List all composers
		lines.push("Custom Composers", "");

		if (state.active) {
			lines.push(`Active: ${state.active.name}`, "");
		}

		if (composers.length === 0) {
			lines.push(
				"No composers configured.",
				"",
				"Create composers in ~/.composer/composers/ or .composer/composers/",
				"",
				"Example composer.yaml:",
				"  name: code-reviewer",
				"  description: Reviews code for best practices",
				"  systemPrompt: |",
				"    You are a code reviewer focused on...",
				"  tools: [read, search, diff]",
			);
		} else {
			for (const composer of composers) {
				const sourceIcon = composer.source === "project" ? "📁" : "🏠";
				const activeMarker =
					state.active?.name === composer.name ? " (active)" : "";
				lines.push(`${sourceIcon} ${composer.name}${activeMarker}`);
				lines.push(`    ${composer.description}`);
			}
		}
	} else {
		// Treat as composer name - show details
		const composer = composers.find((c) => c.name === subcommand);
		if (composer) {
			lines.push(`Name: ${composer.name}`);
			lines.push(`Description: ${composer.description}`);
			lines.push(`Source: ${composer.source} (${composer.filePath})`);
			if (composer.model) {
				lines.push(`Model: ${composer.model}`);
			}
			if (composer.tools?.length) {
				lines.push(`Tools: ${composer.tools.join(", ")}`);
			}
			if (composer.systemPrompt) {
				lines.push("", "System Prompt:", composer.systemPrompt.slice(0, 500));
			}
			if (state.active?.name === composer.name) {
				lines.push("", "(currently active)");
			}
		} else {
			lines.push(`Composer '${subcommand}' not found.`);
			lines.push("");
			lines.push("Usage:");
			lines.push("  /composer              - List available composers");
			lines.push("  /composer <name>       - Show composer details");
			lines.push("  /composer activate <name> - Activate a composer");
			lines.push("  /composer deactivate   - Deactivate current composer");
		}
	}

	renderCtx.addContent(lines.join("\n"));
	renderCtx.requestRender();
}
