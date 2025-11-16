import { spawn, spawnSync } from "node:child_process";
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

interface OllamaListEntry {
	name: string;
	size?: number;
	digest?: string;
	modified_at?: string;
}

export class OllamaView {
	private static readonly POPULAR_MODELS = [
		"llama3.2",
		"codellama",
		"qwen2.5",
		"phi3",
	];
	private static readonly LIST_CACHE_TTL = 30_000;
	private listCache?: { timestamp: number; entries: OllamaListEntry[] };

	constructor(private readonly options: OllamaViewOptions) {}

	async handleOllamaCommand(rawInput: string): Promise<void> {
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
				await this.renderInventory();
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
				await this.streamPull(rest);
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
					const available = this.getLocalModelNames();
					const hint = available.length
						? `Available: ${available.slice(0, 5).join(", ")}${
								available.length > 5 ? "…" : ""
							}`
						: "Configure a local provider via /config local.";
					this.options.showInfoMessage(
						`Usage: /ollama use <model> (accepts provider/model)\n${hint}`,
					);
					return;
				}
				this.handleUseCommand(rest.join(" "));
				return;
			case "doctor":
				await this.handleDoctorCommand();
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
			this.showMissingCliError();
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
			const daemonHint = this.buildDaemonUnavailableHint(details);
			if (daemonHint) {
				body = `${body.trimEnd()}\n\n${daemonHint}`;
			}
		}

		this.renderText(`${heading}\n\n${body.trimEnd()}`);
	}

	private renderInventory(): void {
		const inventory = this.getCachedInventory();
		if (inventory === null) {
			return;
		}
		if (!inventory) {
			this.runAndRender("Installed Ollama models", ["list"]);
			return;
		}

		const localIndex = this.buildLocalModelIndex();
		const lines = inventory.entries.map((entry) => {
			const ready = this.isEntryReady(entry, localIndex);
			const marker = ready ? chalk.green("●") : chalk.dim("○");
			const size = entry.size
				? chalk.cyan(this.formatBytes(entry.size))
				: chalk.dim("?");
			const status = ready
				? chalk.green("ready")
				: chalk.dim("pull to configure");
			return `${marker} ${entry.name.padEnd(24)} ${size.padStart(8)}  ${status}`;
		});

		const freshness = this.listCache
			? chalk.dim(
					`cached ${Math.round((Date.now() - this.listCache.timestamp) / 1000)}s ago`,
				)
			: "";
		const header = `${chalk.bold("Installed Ollama models (JSON)")}${
			freshness ? ` ${freshness}` : ""
		}`;
		const readyHint = chalk.dim(
			`Composer-ready models: ${localIndex.readyNames.size || localIndex.readyTailNames.size ? "highlighted" : "none"}`,
		);
		this.renderText(`${header}\n${readyHint}\n\n${lines.join("\n")}`);
	}

	private getCachedInventory(
		forceRefresh = false,
	): { entries: OllamaListEntry[] } | null | undefined {
		if (!forceRefresh && this.listCache) {
			const fresh =
				Date.now() - this.listCache.timestamp < OllamaView.LIST_CACHE_TTL;
			if (fresh) {
				return { entries: this.listCache.entries };
			}
		}

		const result = this.runOllama(["list", "--json"]);
		if (result.missingCli) {
			this.showMissingCliError();
			return null;
		}
		if (!result.ok || !result.stdout.trim()) {
			return undefined;
		}
		try {
			const parsed = JSON.parse(result.stdout) as OllamaListEntry[];
			this.listCache = { timestamp: Date.now(), entries: parsed };
			return { entries: parsed };
		} catch (error) {
			this.options.showErrorMessage(
				`Failed to parse ollama list output: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return undefined;
		}
	}

	private buildLocalModelIndex(): {
		readyNames: Set<string>;
		readyTailNames: Set<string>;
	} {
		const readyNames = new Set<string>();
		const readyTailNames = new Set<string>();
		for (const model of this.options.getRegisteredModels()) {
			if (!model.isLocal) continue;
			const lowerId = model.id.toLowerCase();
			readyNames.add(lowerId);
			const tail = lowerId.split("/").pop();
			if (tail) {
				readyTailNames.add(tail);
			}
		}
		return { readyNames, readyTailNames };
	}

	private isEntryReady(
		entry: OllamaListEntry,
		index: { readyNames: Set<string>; readyTailNames: Set<string> },
	): boolean {
		const name = entry.name.toLowerCase();
		return (
			index.readyNames.has(name) ||
			index.readyNames.has(`ollama/${name}`) ||
			index.readyTailNames.has(name)
		);
	}

	private formatBytes(bytes: number): string {
		if (!Number.isFinite(bytes)) {
			return "?";
		}
		if (bytes < 1024) return `${bytes}B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
		if (bytes < 1024 * 1024 * 1024)
			return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
		return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
	}

	private async streamPull(modelParts: string[]): Promise<void> {
		return await new Promise((resolve) => {
			const heading = `${chalk.bold(`Pulling ${modelParts.join(" ")}`)}\n${chalk.dim(
				`$ ollama pull ${modelParts.join(" ")}`,
			)}`;
			const textComponent = new Text("", 1, 0);
			this.options.chatContainer.addChild(new Spacer(1));
			this.options.chatContainer.addChild(textComponent);
			textComponent.setText(`${heading}\n\nStarting download…`);
			this.options.ui.requestRender();

			const child = spawn("ollama", ["pull", ...modelParts], {
				cwd: process.cwd(),
				env: process.env,
			});
			let buffer = "";
			const update = (chunk: Buffer) => {
				buffer += chunk.toString();
				textComponent.setText(`${heading}\n\n${buffer.trimEnd()}`);
				this.options.ui.requestRender();
			};
			child.stdout?.on("data", update);
			child.stderr?.on("data", update);
			child.on("error", (error) => {
				textComponent.setText(
					`${heading}\n\n${chalk.red(
						error instanceof Error ? error.message : String(error),
					)}`,
				);
				this.options.ui.requestRender();
				resolve();
			});
			child.on("close", (code) => {
				const status =
					code === 0 ? chalk.green("Complete") : chalk.red("Failed");
				const tail = buffer.trim().length
					? buffer.trimEnd()
					: code === 0
						? "Model is ready to use."
						: "Command exited without output.";
				textComponent.setText(`${heading}\n\n${status}\n${tail}`);
				this.options.ui.requestRender();
				resolve();
			});
		});
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
Use /ollama use <model> to switch Composer to a local model.
Use /ollama doctor to diagnose daemon + disk health.`;
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

	private getLocalModelNames(): string[] {
		return this.options
			.getRegisteredModels()
			.filter((model) => model.isLocal)
			.map((model) => model.id)
			.sort();
	}

	private async handleDoctorCommand(): Promise<void> {
		const lines: string[] = [];
		const cli = this.runOllama(["version"]);
		const cliStatus = cli.ok
			? chalk.green("available")
			: chalk.red(`missing${cli.stderr ? ` (${cli.stderr})` : ""}`);
		lines.push(`${chalk.bold("CLI")}: ${cliStatus}`);
		const daemon = await this.checkDaemon();
		lines.push(
			`${chalk.bold("Daemon")}: ${daemon.ok ? chalk.green(daemon.message) : chalk.red(daemon.message)}`,
		);
		if (this.listCache) {
			lines.push(
				chalk.dim(
					`Cached inventory: ${this.listCache.entries.length} models (age ${Math.round((Date.now() - this.listCache.timestamp) / 1000)}s)`,
				),
			);
		}
		const disk = this.runSystemCommand(["df", "-h", process.cwd()]);
		if (disk) {
			lines.push(`${chalk.bold("Disk")}:\n${disk}`);
		}
		this.renderText(`${chalk.bold("Ollama diagnostics")}\n${lines.join("\n")}`);
	}

	private async checkDaemon(): Promise<{ ok: boolean; message: string }> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 2000);
		try {
			const response = await fetch("http://127.0.0.1:11434/api/version", {
				method: "GET",
				signal: controller.signal,
			});
			clearTimeout(timeout);
			if (!response.ok) {
				return { ok: false, message: `HTTP ${response.status}` };
			}
			const body = await response.text();
			return { ok: true, message: body.trim() || "reachable" };
		} catch (error) {
			clearTimeout(timeout);
			return {
				ok: false,
				message:
					error instanceof Error ? error.message : String(error ?? "offline"),
			};
		}
	}

	private runSystemCommand(args: string[]): string | undefined {
		try {
			const result = spawnSync(args[0], args.slice(1), {
				cwd: process.cwd(),
				encoding: "utf-8",
			});
			if ((result.status ?? 0) !== 0) {
				return undefined;
			}
			const lines = (result.stdout ?? "").trim().split("\n");
			return lines.slice(0, 3).join("\n");
		} catch {
			return undefined;
		}
	}

	private showMissingCliError(): void {
		this.options.showErrorMessage(
			"Ollama CLI not found. Install it from https://ollama.com/download and ensure it's on your PATH.",
		);
	}

	private buildDaemonUnavailableHint(
		output: string | undefined,
	): string | undefined {
		if (!output) {
			return undefined;
		}
		const patterns = [
			/ollama server not responding/i,
			/could not find ollama app/i,
			/connection refused/i,
		];
		if (!patterns.some((pattern) => pattern.test(output))) {
			return undefined;
		}
		return `${chalk.yellow("Hint")}: Launch the Ollama desktop app or run ${chalk.cyan(
			"ollama serve",
		)} so the daemon is reachable at http://127.0.0.1:11434.`;
	}

	private renderText(body: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(body, 1, 0));
		this.options.ui.requestRender();
	}
}
