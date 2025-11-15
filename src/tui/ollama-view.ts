import { spawnSync } from "node:child_process";
import chalk from "chalk";
import type { RegisteredModel } from "../models/registry.js";
import type { Container, TUI } from "../tui-lib/index.js";
import { Spacer, Text } from "../tui-lib/index.js";

interface OllamaViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfoMessage: (message: string) => void;
	showErrorMessage: (message: string) => void;
	getRegisteredModels: () => RegisteredModel[];
	onUseModel: (model: RegisteredModel) => void;
}

interface OllamaCommandResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	missingCli: boolean;
}

export class OllamaView {
	private static readonly POPULAR_MODELS = [
		"llama3.2",
		"codellama",
		"qwen2.5",
		"phi3",
	];

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
					this.options.showInfoMessage(
						`Usage: /ollama pull <model>\nPopular models: ${OllamaView.POPULAR_MODELS.join(
							", ",
						)}`,
					);
					return;
				}
				this.runAndRender(`Pulling ${rest.join(" ")}`, ["pull", ...rest]);
				return;
			case "show":
				if (rest.length === 0) {
					this.options.showInfoMessage("Usage: /ollama show <model>");
					return;
				}
				this.runAndRender(`Model details for ${rest.join(" ")}`, [
					"show",
					...rest,
				]);
				return;
			case "use":
				if (rest.length === 0) {
					this.options.showInfoMessage(
						"Usage: /ollama use <model> (accepts provider/model)",
					);
					return;
				}
				this.handleUseCommand(rest.join(" "));
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
Use /ollama ps to see currently running models.
Use /ollama show <model> to inspect metadata.
Use /ollama use <model> to switch Composer to a local model.`;
		this.renderText(message);
	}

	private handleUseCommand(specifier: string): void {
		const match = this.resolveLocalModel(specifier);
		if (!match) {
			this.options.showInfoMessage(
				`Could not find a local model matching "${specifier}". Ensure it's configured via /config or /ollama list.`,
			);
			return;
		}
		this.options.onUseModel(match);
		const message = `${chalk.bold("Model switched")}
Now using ${match.id} (${match.providerName}).`;
		this.renderText(message);
	}

	private resolveLocalModel(specifier: string): RegisteredModel | undefined {
		const normalized = specifier.toLowerCase();
		const models = this.options
			.getRegisteredModels()
			.filter((model) => model.isLocal);
		const exactMatch = models.find(
			(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
		);
		if (exactMatch) {
			return exactMatch;
		}
		const shorthandMatches = models.filter((model) => {
			const id = model.id.toLowerCase();
			if (id === normalized) {
				return true;
			}
			const tail = id.split("/").pop();
			return tail === normalized;
		});
		if (shorthandMatches.length === 1) {
			return shorthandMatches[0];
		}
		if (shorthandMatches.length > 1) {
			this.options.showInfoMessage(
				`Multiple matches for "${specifier}". Use provider/model format (e.g. ollama/${specifier}).`,
			);
		}
		return undefined;
	}

	private renderText(body: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
