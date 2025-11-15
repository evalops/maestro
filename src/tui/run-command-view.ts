import { readFileSync } from "node:fs";
import { join } from "node:path";
import { badge, heading, muted } from "../style/theme.js";
import type { AutocompleteItem } from "../tui-lib/index.js";
import { type Container, Spacer, type TUI, Text } from "../tui-lib/index.js";
import { runShellCommand } from "./run-shell-command.js";

interface RunCommandViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
}

export class RunCommandView {
	private runScripts: string[] = [];

	constructor(private readonly options: RunCommandViewOptions) {}

	async handleRunCommand(text: string): Promise<void> {
		const parts = text.trim().split(/\s+/);
		if (parts.length < 2) {
			this.options.showInfoMessage("Usage: /run <script> [args]");
			return;
		}
		const script = parts[1];
		const args = parts.slice(2).join(" ");
		const command = args ? `npm run ${script} -- ${args}` : `npm run ${script}`;

		this.options.chatContainer.addChild(new Spacer(1));
		const outputComponent = new Text(
			`${heading(`$ ${command}`)}\n${muted("Running…")}`,
			1,
			0,
		);
		this.options.chatContainer.addChild(outputComponent);
		this.options.ui.requestRender();

		const result = await runShellCommand(command);
		const statusLine = badge(
			"Exit code",
			String(result.code ?? 0),
			result.success ? "success" : "danger",
		);
		const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
		outputComponent.setText(
			`${heading(`$ ${command}`)}\n${body || muted("(no output)")}\n\n${statusLine}`,
		);
		this.options.ui.requestRender();
	}

	getRunScriptCompletions(prefix: string): AutocompleteItem[] | null {
		if (!this.runScripts.length) {
			this.runScripts = this.loadRunScripts();
		}
		if (!this.runScripts.length) {
			return null;
		}
		const lower = prefix.toLowerCase();
		const matches = this.runScripts
			.filter((script) => script.toLowerCase().startsWith(lower))
			.slice(0, 10);
		if (!matches.length) {
			return null;
		}
		return matches.map((script) => ({
			value: script,
			label: script,
			description: "package script",
		}));
	}

	private loadRunScripts(): string[] {
		try {
			const pkgPath = join(process.cwd(), "package.json");
			const raw = readFileSync(pkgPath, "utf-8");
			const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
			return pkg?.scripts ? Object.keys(pkg.scripts) : [];
		} catch {
			return [];
		}
	}
}
