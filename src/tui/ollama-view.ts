import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface OllamaViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	showErrorMessage: (message: string) => void;
}

interface OllamaCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	missingCli: boolean;
}

export class OllamaView {
	constructor(private readonly options: OllamaViewOptions) {}

	handleOllamaCommand(rawInput: string): void {
		const argumentText = rawInput.replace(/^\/ollama\b/i, "").trim();
		if (!argumentText || argumentText.toLowerCase() === "help") {
			this.renderUsage();
			return;
		}

		const tokens = argumentText.split(/\s+/).filter(Boolean);
		const action = tokens[0]?.toLowerCase();
		const rest = tokens.slice(1);

		switch (action) {
			case "list":
				this.runAndRender("Installed Ollama models", ["list"]);
				return;
			case "ps":
				this.runAndRender("Running Ollama models", ["ps"]);
				return;
			case "pull":
				if (rest.length === 0) {
					this.options.showInfoMessage("Usage: /ollama pull <model>");
					return;
				}
				this.runAndRender(`Pulling ${rest.join(" ")}`, ["pull", ...rest]);
				return;
			default:
				this.options.showInfoMessage(
					`Unknown ollama action "${action ?? ""}". Try /ollama help for usage.`,
				);
				this.renderUsage();
		}
	}

	private runAndRender(summary: string, args: string[]): void {
		const result = this.runOllama(args);
		if (result.missingCli) {
			this.options.showErrorMessage(
				"Ollama CLI not found. Install it from https://ollama.com/download and ensure it's on your PATH.",
			);
			return;
		}

		const heading = `${chalk.bold(summary)}\n${chalk.dim(`$ ollama ${args.join(" ")}`)}`;
		let body: string;
		if (result.ok) {
			const output = result.stdout || result.stderr;
			body = output.trim().length
				? output
				: chalk.dim("Command completed with no output.");
		} else {
			const details = result.stderr || result.stdout || "Command failed.";
			body = chalk.red(details.trim().length ? details : "Command failed.");
		}

		this.renderText(`${heading}\n\n${body.trimEnd()}`);
	}

	private runOllama(args: string[]): OllamaCommandResult {
		try {
			const result = spawnSync("ollama", args, {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			const missing = Boolean(
				(result as { error?: NodeJS.ErrnoException }).error?.code === "ENOENT",
			);
			return {
				ok: (result.status ?? 0) === 0,
				stdout: (result.stdout ?? "").trimEnd(),
				stderr: (result.stderr ?? "").trimEnd(),
				missingCli: missing,
			};
		} catch (error) {
			const isMissing =
				(error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
			return {
				ok: false,
				stdout: "",
				stderr:
					error instanceof Error
						? error.message
						: String(error ?? "Unable to run ollama command."),
				missingCli: Boolean(isMissing),
			};
		}
	}

	private renderUsage(): void {
		const message = `${chalk.bold("Ollama control plane")}
Use /ollama list to view installed models.
Use /ollama pull <model> to download one (e.g. /ollama pull llama3).
Use /ollama ps to see currently running models.`;
		this.renderText(message);
	}

	private renderText(body: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
