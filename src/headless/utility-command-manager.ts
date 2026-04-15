import { type ChildProcess, spawn } from "node:child_process";
import type {
	HeadlessUtilityCommandShellMode,
	HeadlessUtilityCommandStream,
	HeadlessUtilityCommandTerminalMode,
} from "@evalops/contracts";
import {
	getShellConfig,
	killProcessTree,
	killProcessTreeGracefully,
	parseCommandArguments,
	validateShellParams,
} from "../tools/shell-utils.js";
import { appendHeadlessOutput } from "./output-buffer.js";
import {
	HEADLESS_PTY_HELPER_SCRIPT,
	encodeHeadlessPtyHelperConfig,
	getHeadlessPtyPythonCommand,
} from "./pty-helper.js";

export interface HeadlessUtilityCommandStartRequest {
	command_id: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	shell_mode?: HeadlessUtilityCommandShellMode;
	terminal_mode?: HeadlessUtilityCommandTerminalMode;
	allow_stdin?: boolean;
	columns?: number;
	rows?: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityCommandStartedEvent {
	type: "started";
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	terminal_mode: HeadlessUtilityCommandTerminalMode;
	pid?: number;
	columns?: number;
	rows?: number;
	owner_connection_id?: string;
}

export interface HeadlessUtilityCommandResizedEvent {
	type: "resized";
	command_id: string;
	columns: number;
	rows: number;
}

export interface HeadlessUtilityCommandOutputEvent {
	type: "output";
	command_id: string;
	stream: HeadlessUtilityCommandStream;
	content: string;
}

export interface HeadlessUtilityCommandExitedEvent {
	type: "exited";
	command_id: string;
	success: boolean;
	exit_code?: number | null;
	signal?: string | null;
	reason?: string;
}

export type HeadlessUtilityCommandEvent =
	| HeadlessUtilityCommandStartedEvent
	| HeadlessUtilityCommandResizedEvent
	| HeadlessUtilityCommandOutputEvent
	| HeadlessUtilityCommandExitedEvent;

interface PtyCommandState {
	lineBuffer: string;
	errorOutput: string;
	startResolved: boolean;
}

interface ActiveCommand {
	child: ChildProcess;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	terminal_mode: HeadlessUtilityCommandTerminalMode;
	allow_stdin: boolean;
	owner_connection_id?: string;
	output: string;
	columns?: number;
	rows?: number;
	reason?: string;
	pty?: PtyCommandState;
}

export interface HeadlessUtilityCommandSnapshot {
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	terminal_mode: HeadlessUtilityCommandTerminalMode;
	pid?: number;
	columns?: number;
	rows?: number;
	owner_connection_id?: string;
	output: string;
}

interface ParsedPtyControlMessage {
	type: "started" | "output" | "resized" | "exited" | "error";
	pid?: number;
	content?: string;
	columns?: number;
	rows?: number;
	success?: boolean;
	exit_code?: number | null;
	signal?: string | null;
	reason?: string;
	message?: string;
}

const DEFAULT_PTY_COLUMNS = 80;
const DEFAULT_PTY_ROWS = 24;

function normalizeTerminalMode(
	value?: HeadlessUtilityCommandTerminalMode,
): HeadlessUtilityCommandTerminalMode {
	return value ?? "pipe";
}

function normalizePtyDimension(
	value: number | undefined,
	fallback: number,
	label: string,
): number {
	if (value === undefined) {
		return fallback;
	}
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Utility command ${label} must be a positive integer`);
	}
	return value;
}

function buildSnapshot(
	commandId: string,
	active: ActiveCommand,
): HeadlessUtilityCommandSnapshot {
	return {
		command_id: commandId,
		command: active.command,
		cwd: active.cwd,
		shell_mode: active.shell_mode,
		terminal_mode: active.terminal_mode,
		pid: active.child.pid ?? undefined,
		columns: active.columns,
		rows: active.rows,
		owner_connection_id: active.owner_connection_id,
		output: active.output,
	};
}

export class HeadlessUtilityCommandManager {
	private readonly commands = new Map<string, ActiveCommand>();

	constructor(
		private readonly emit: (event: HeadlessUtilityCommandEvent) => void,
	) {}

	snapshot(): HeadlessUtilityCommandSnapshot[] {
		return Array.from(this.commands.entries()).map(([commandId, active]) =>
			buildSnapshot(commandId, active),
		);
	}

	get(commandId: string): HeadlessUtilityCommandSnapshot | undefined {
		const active = this.commands.get(commandId);
		if (!active) {
			return undefined;
		}
		return buildSnapshot(commandId, active);
	}

	async start(request: HeadlessUtilityCommandStartRequest): Promise<void> {
		if (this.commands.has(request.command_id)) {
			throw new Error(`Utility command already exists: ${request.command_id}`);
		}

		const shellMode = request.shell_mode ?? "shell";
		const terminalMode = normalizeTerminalMode(request.terminal_mode);
		const allowStdin = request.allow_stdin ?? false;
		const { resolvedCwd } = validateShellParams(
			request.command,
			request.cwd,
			request.env,
		);
		const env = request.env ? { ...process.env, ...request.env } : process.env;

		if (terminalMode === "pty") {
			await this.startPtyCommand({
				...request,
				cwd: resolvedCwd,
				shell_mode: shellMode,
				terminal_mode: terminalMode,
				allow_stdin: allowStdin,
			});
			return;
		}

		if (request.columns !== undefined || request.rows !== undefined) {
			throw new Error(
				"Utility command columns and rows require terminal_mode=pty",
			);
		}

		let child: ChildProcess;
		if (shellMode === "shell") {
			const { shell, args } = getShellConfig();
			child = spawn(shell, [...args, request.command], {
				cwd: resolvedCwd,
				env,
				stdio: [allowStdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
		} else {
			const parsed = parseCommandArguments(request.command);
			if (parsed.length === 0) {
				throw new Error("Command must contain an executable to run");
			}
			child = spawn(parsed[0]!, parsed.slice(1), {
				cwd: resolvedCwd,
				env,
				stdio: [allowStdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
		}

		const active: ActiveCommand = {
			child,
			command: request.command,
			cwd: resolvedCwd,
			shell_mode: shellMode,
			terminal_mode: terminalMode,
			allow_stdin: allowStdin,
			owner_connection_id: request.owner_connection_id,
			output: "",
		};
		this.commands.set(request.command_id, active);
		this.emit({
			type: "started",
			command_id: request.command_id,
			command: request.command,
			cwd: resolvedCwd,
			shell_mode: shellMode,
			terminal_mode: terminalMode,
			pid: child.pid ?? undefined,
			owner_connection_id: request.owner_connection_id,
		});

		child.stdout?.on("data", (chunk: Buffer) => {
			const content = chunk.toString("utf8");
			active.output = appendHeadlessOutput(active.output, content);
			this.emit({
				type: "output",
				command_id: request.command_id,
				stream: "stdout",
				content,
			});
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			const content = chunk.toString("utf8");
			active.output = appendHeadlessOutput(active.output, content);
			this.emit({
				type: "output",
				command_id: request.command_id,
				stream: "stderr",
				content,
			});
		});
		child.on("error", (error) => {
			this.finish(request.command_id, {
				success: false,
				reason: error.message,
			});
		});
		child.on("close", (exitCode, signal) => {
			this.finish(request.command_id, {
				success: exitCode === 0 && !signal,
				exit_code: exitCode,
				signal,
				reason: active.reason,
			});
		});
	}

	async terminate(
		commandId: string,
		force = false,
		reason?: string,
	): Promise<void> {
		const active = this.commands.get(commandId);
		if (!active) {
			return;
		}
		active.reason =
			reason ??
			active.reason ??
			(force ? "Force terminated by controller" : "Terminated by controller");

		if (active.terminal_mode === "pty") {
			try {
				await this.sendPtyControl(active, {
					type: "terminate",
					force,
					reason: active.reason,
				});
				return;
			} catch {
				const pid = active.child.pid;
				if (pid) {
					killProcessTree(pid);
				}
				return;
			}
		}

		const pid = active.child.pid;
		if (!pid) {
			return;
		}
		if (force) {
			killProcessTree(pid);
			return;
		}
		await killProcessTreeGracefully(pid);
	}

	async writeStdin(
		commandId: string,
		content: string,
		eof = false,
	): Promise<void> {
		const active = this.commands.get(commandId);
		if (!active) {
			throw new Error(`Utility command not found: ${commandId}`);
		}
		if (!active.allow_stdin) {
			throw new Error(`Utility command stdin is not enabled: ${commandId}`);
		}

		if (active.terminal_mode === "pty") {
			await this.sendPtyControl(active, {
				type: "stdin",
				content,
				eof,
			});
			return;
		}

		const stdin = active.child.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) {
			if (!content && eof) {
				return;
			}
			throw new Error(`Utility command stdin is not writable: ${commandId}`);
		}
		if (content) {
			await new Promise<void>((resolve, reject) => {
				stdin.write(content, (error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
		if (eof && !stdin.destroyed && !stdin.writableEnded) {
			stdin.end();
		}
	}

	async resize(
		commandId: string,
		columns: number,
		rows: number,
	): Promise<void> {
		const active = this.commands.get(commandId);
		if (!active) {
			throw new Error(`Utility command not found: ${commandId}`);
		}
		if (active.terminal_mode !== "pty") {
			throw new Error(
				`Utility command resize is only supported for PTY commands: ${commandId}`,
			);
		}
		await this.sendPtyControl(active, {
			type: "resize",
			columns: normalizePtyDimension(columns, DEFAULT_PTY_COLUMNS, "columns"),
			rows: normalizePtyDimension(rows, DEFAULT_PTY_ROWS, "rows"),
		});
	}

	async dispose(reason = "Headless runtime disposed"): Promise<void> {
		const commandIds = Array.from(this.commands.keys());
		for (const commandId of commandIds) {
			const active = this.commands.get(commandId);
			if (!active) {
				continue;
			}
			try {
				await this.terminate(commandId, false, reason);
			} catch {
				// Best-effort shutdown.
			}
		}
	}

	async disposeOwnedByConnection(
		connectionId: string,
		reason: string,
	): Promise<void> {
		const commandIds = Array.from(this.commands.entries())
			.filter(([, active]) => active.owner_connection_id === connectionId)
			.map(([commandId]) => commandId);
		for (const commandId of commandIds) {
			const active = this.commands.get(commandId);
			if (!active) {
				continue;
			}
			try {
				await this.terminate(commandId, false, reason);
			} catch {
				// Best-effort shutdown.
			}
		}
	}

	private async startPtyCommand(
		request: HeadlessUtilityCommandStartRequest & {
			cwd?: string;
			shell_mode: HeadlessUtilityCommandShellMode;
			terminal_mode: HeadlessUtilityCommandTerminalMode;
			allow_stdin: boolean;
		},
	): Promise<void> {
		if (process.platform === "win32") {
			throw new Error("PTY utility commands are not supported on Windows");
		}

		const columns = normalizePtyDimension(
			request.columns,
			DEFAULT_PTY_COLUMNS,
			"columns",
		);
		const rows = normalizePtyDimension(request.rows, DEFAULT_PTY_ROWS, "rows");
		const env = request.env ? { ...process.env, ...request.env } : process.env;
		const directArgv =
			request.shell_mode === "direct"
				? parseCommandArguments(request.command)
				: [];
		if (request.shell_mode === "direct" && directArgv.length === 0) {
			throw new Error("Command must contain an executable to run");
		}
		const config = {
			command: request.command,
			cwd: request.cwd,
			env: request.env,
			shell_mode: request.shell_mode,
			columns,
			rows,
			...(request.shell_mode === "direct" ? { argv: directArgv } : {}),
		} as const;

		const child = spawn(
			getHeadlessPtyPythonCommand(),
			["-c", HEADLESS_PTY_HELPER_SCRIPT, encodeHeadlessPtyHelperConfig(config)],
			{
				cwd: request.cwd,
				env,
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		const active: ActiveCommand = {
			child,
			command: request.command,
			cwd: request.cwd,
			shell_mode: request.shell_mode,
			terminal_mode: request.terminal_mode,
			allow_stdin: request.allow_stdin,
			owner_connection_id: request.owner_connection_id,
			output: "",
			columns,
			rows,
			pty: {
				lineBuffer: "",
				errorOutput: "",
				startResolved: false,
			},
		};
		this.commands.set(request.command_id, active);

		await new Promise<void>((resolve, reject) => {
			let startSettled = false;
			const settleStart = (callback: () => void) => {
				if (startSettled) {
					return;
				}
				startSettled = true;
				callback();
			};
			const finishWithError = (message: string) => {
				active.reason = message;
				settleStart(() => reject(new Error(message)));
				this.finish(request.command_id, {
					success: false,
					reason: message,
				});
			};

			child.stdout?.on("data", (chunk: Buffer) => {
				const ptyState = active.pty;
				if (!ptyState) {
					return;
				}
				ptyState.lineBuffer += chunk.toString("utf8");
				while (true) {
					const newlineIndex = ptyState.lineBuffer.indexOf("\n");
					if (newlineIndex === -1) {
						break;
					}
					const rawLine = ptyState.lineBuffer.slice(0, newlineIndex).trim();
					ptyState.lineBuffer = ptyState.lineBuffer.slice(newlineIndex + 1);
					if (!rawLine) {
						continue;
					}
					let message: ParsedPtyControlMessage;
					try {
						message = JSON.parse(rawLine) as ParsedPtyControlMessage;
					} catch {
						finishWithError("Malformed PTY helper message");
						return;
					}
					switch (message.type) {
						case "started":
							active.columns = message.columns ?? active.columns;
							active.rows = message.rows ?? active.rows;
							ptyState.startResolved = true;
							this.emit({
								type: "started",
								command_id: request.command_id,
								command: request.command,
								cwd: request.cwd,
								shell_mode: request.shell_mode,
								terminal_mode: request.terminal_mode,
								pid: message.pid ?? child.pid ?? undefined,
								columns: active.columns,
								rows: active.rows,
								owner_connection_id: request.owner_connection_id,
							});
							settleStart(resolve);
							break;
						case "output": {
							const content = message.content ?? "";
							active.output = appendHeadlessOutput(active.output, content);
							this.emit({
								type: "output",
								command_id: request.command_id,
								stream: "stdout",
								content,
							});
							break;
						}
						case "resized":
							active.columns = message.columns ?? active.columns;
							active.rows = message.rows ?? active.rows;
							this.emit({
								type: "resized",
								command_id: request.command_id,
								columns: active.columns ?? columns,
								rows: active.rows ?? rows,
							});
							break;
						case "error":
							finishWithError(
								message.message ?? "PTY utility command helper failed",
							);
							return;
						case "exited":
							settleStart(resolve);
							this.finish(request.command_id, {
								success: message.success ?? false,
								exit_code: message.exit_code,
								signal: message.signal,
								reason:
									message.reason ?? active.reason ?? active.pty?.errorOutput,
							});
							break;
					}
				}
			});

			child.stderr?.on("data", (chunk: Buffer) => {
				const ptyState = active.pty;
				if (!ptyState) {
					return;
				}
				ptyState.errorOutput = appendHeadlessOutput(
					ptyState.errorOutput,
					chunk.toString("utf8"),
				);
			});

			child.on("error", (error) => {
				finishWithError(error.message);
			});

			child.on("close", (exitCode, signal) => {
				if (this.commands.has(request.command_id)) {
					this.finish(request.command_id, {
						success: exitCode === 0 && !signal,
						exit_code: exitCode,
						signal,
						reason: active.reason ?? active.pty?.errorOutput,
					});
				}
				settleStart(() => {
					if (active.pty?.startResolved) {
						resolve();
						return;
					}
					reject(
						new Error(
							active.reason ??
								active.pty?.errorOutput ??
								"PTY utility command exited before startup completed",
						),
					);
				});
			});
		});
	}

	private async sendPtyControl(
		active: ActiveCommand,
		control:
			| { type: "stdin"; content: string; eof: boolean }
			| { type: "resize"; columns: number; rows: number }
			| { type: "terminate"; force: boolean; reason?: string },
	): Promise<void> {
		const stdin = active.child.stdin;
		if (!stdin || stdin.destroyed || stdin.writableEnded) {
			throw new Error("PTY utility command control channel is not writable");
		}
		await new Promise<void>((resolve, reject) => {
			stdin.write(`${JSON.stringify(control)}\n`, (error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	private finish(
		commandId: string,
		event: Omit<HeadlessUtilityCommandExitedEvent, "type" | "command_id">,
	): void {
		if (!this.commands.has(commandId)) {
			return;
		}
		this.commands.delete(commandId);
		this.emit({
			type: "exited",
			command_id: commandId,
			...event,
		});
	}
}
