import type { Container, TUI } from "@evalops/tui";
import { Spacer, Text } from "@evalops/tui";
import chalk from "chalk";
import { FEATURES } from "../config/constants.js";
import { detectLspServers } from "../lsp/autodetect.js";
import { autostartLspServers } from "../lsp/autostart.js";
import { getClients } from "../lsp/index.js";
import { lspManager } from "../lsp/manager.js";

interface LspViewOptions {
	chatContainer: Container;
	ui: TUI;
	showInfo(message: string): void;
	showError(message: string): void;
}

export class LspView {
	constructor(private readonly options: LspViewOptions) {}

	async handleLspCommand(rawInput: string): Promise<void> {
		const args = rawInput.replace(/^\/lsp\s*/, "").trim();
		const subcommand = args.split(/\s+/)[0]?.toLowerCase() || "";

		switch (subcommand) {
			case "start":
				await this.handleStart();
				break;
			case "stop": {
				const success = await this.handleStop();
				if (!success) return;
				break;
			}
			case "restart":
				await this.handleRestart();
				break;
			case "detect":
				await this.handleDetect();
				break;
			case "status":
			case "":
				await this.handleStatus();
				break;
			default:
				this.options.showError(`Unknown subcommand: ${subcommand}`);
				this.showUsage();
				break;
		}
	}

	private async handleStatus(): Promise<void> {
		const lines: string[] = [chalk.bold("LSP Server Status"), ""];

		// Show feature flags
		const enabledStatus = FEATURES.LSP_ENABLED
			? chalk.green("enabled")
			: chalk.red("disabled");
		const autostartStatus = FEATURES.LSP_AUTOSTART
			? chalk.green("on")
			: chalk.dim("off");
		lines.push(`LSP: ${enabledStatus} | Autostart: ${autostartStatus}`, "");

		// Get active clients
		const clients = await getClients();

		if (clients.length === 0) {
			lines.push(chalk.dim("No active LSP servers."), "");
			lines.push(
				chalk.dim("Use /lsp start to start servers or /lsp detect to scan."),
			);
		} else {
			lines.push(chalk.bold(`Active Servers (${clients.length}):`));
			for (const client of clients) {
				const statusIcon = client.initialized
					? chalk.green("●")
					: chalk.yellow("○");
				const fileCount = client.openFiles.size;
				const diagCount = Array.from(client.diagnostics.values()).reduce(
					(sum, d) => sum + d.length,
					0,
				);
				lines.push(`  ${statusIcon} ${client.id}`);
				lines.push(`      Root: ${chalk.dim(client.root)}`);
				lines.push(`      Files: ${fileCount} | Diagnostics: ${diagCount}`);
			}
		}

		lines.push("");
		lines.push(chalk.dim("Subcommands: status, start, stop, restart, detect"));

		this.addContent(lines.join("\n"));
	}

	private async handleStart(): Promise<void> {
		if (!FEATURES.LSP_ENABLED) {
			this.options.showError(
				"LSP is disabled. Set MAESTRO_LSP_ENABLED=1 to enable.",
			);
			return;
		}

		this.options.showInfo("Starting LSP servers...");

		try {
			await autostartLspServers(process.cwd());
			const clients = await getClients();
			if (clients.length > 0) {
				this.options.showInfo(
					`Started ${clients.length} LSP server(s): ${clients.map((c) => c.id).join(", ")}`,
				);
			} else {
				this.options.showInfo(
					"No LSP servers started. Run /lsp detect to see available servers.",
				);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.showError(`Failed to start LSP servers: ${message}`);
		}
	}

	private async handleStop(): Promise<boolean> {
		if (!FEATURES.LSP_ENABLED) {
			this.options.showError(
				"LSP is disabled. Set MAESTRO_LSP_ENABLED=1 to enable.",
			);
			return false;
		}

		const clients = await getClients();
		if (clients.length === 0) {
			this.options.showInfo("No active LSP servers to stop.");
			return true; // Success, nothing to stop
		}

		this.options.showInfo("Stopping all LSP servers...");

		try {
			await lspManager.shutdownAll();
			this.options.showInfo(`Stopped ${clients.length} LSP server(s).`);
			return true; // Success
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.showError(`Failed to stop LSP servers: ${message}`);
			return false; // Failure
		}
	}

	private async handleRestart(): Promise<void> {
		if (!FEATURES.LSP_ENABLED) {
			this.options.showError(
				"LSP is disabled. Set MAESTRO_LSP_ENABLED=1 to enable.",
			);
			return;
		}

		this.options.showInfo("Restarting LSP servers...");

		// First attempt stop
		const stopSuccess = await this.handleStop();
		if (!stopSuccess) {
			// If stop failed, don't attempt start to avoid orphan processes
			this.options.showError("Restart aborted due to stop failure.");
			return;
		}

		// Only proceed with start if stop succeeded
		await this.handleStart();
	}

	private async handleDetect(): Promise<void> {
		const lines: string[] = [chalk.bold("LSP Server Detection"), ""];

		try {
			const detections = await detectLspServers(process.cwd());

			if (detections.length === 0) {
				lines.push(
					chalk.dim("No language servers detected for this workspace."),
				);
				lines.push("");
				lines.push("Supported servers:");
				lines.push("  - typescript-language-server (TypeScript/JavaScript)");
				lines.push("  - pyright-langserver (Python)");
				lines.push("  - gopls (Go)");
				lines.push("  - rust-analyzer (Rust)");
				lines.push("  - vue-language-server (Vue)");
				lines.push("  - vscode-eslint-language-server (ESLint)");
			} else {
				lines.push(`Found ${detections.length} available server(s):`);
				for (const detection of detections) {
					lines.push(`  ${chalk.green("●")} ${detection.serverId}`);
					lines.push(`      Root: ${chalk.dim(detection.root)}`);
				}
				lines.push("");
				lines.push(chalk.dim("Use /lsp start to start these servers."));
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			lines.push(chalk.red(`Detection failed: ${message}`));
		}

		this.addContent(lines.join("\n"));
	}

	private showUsage(): void {
		const lines = [
			chalk.bold("LSP Command Usage"),
			"",
			"  /lsp              Show server status (default)",
			"  /lsp status       Show server status",
			"  /lsp start        Start detected LSP servers",
			"  /lsp stop         Stop all LSP servers",
			"  /lsp restart      Restart all LSP servers",
			"  /lsp detect       Detect available LSP servers",
		];
		this.addContent(lines.join("\n"));
	}

	private addContent(content: string): void {
		this.options.chatContainer.addChild(new Spacer(1));
		this.options.chatContainer.addChild(new Text(content, 1, 0));
		this.options.ui.requestRender();
	}
}
