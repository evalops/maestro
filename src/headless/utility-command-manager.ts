import { type ChildProcess, spawn } from "node:child_process";
import type {
	HeadlessUtilityCommandShellMode,
	HeadlessUtilityCommandStream,
} from "@evalops/contracts";
import {
	getShellConfig,
	killProcessTree,
	killProcessTreeGracefully,
	parseCommandArguments,
	validateShellParams,
} from "../tools/shell-utils.js";
import { appendHeadlessOutput } from "./output-buffer.js";

export interface HeadlessUtilityCommandStartRequest {
	command_id: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	shell_mode?: HeadlessUtilityCommandShellMode;
}

export interface HeadlessUtilityCommandStartedEvent {
	type: "started";
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	pid?: number;
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
	| HeadlessUtilityCommandOutputEvent
	| HeadlessUtilityCommandExitedEvent;

interface ActiveCommand {
	child: ChildProcess;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	output: string;
	reason?: string;
}

export interface HeadlessUtilityCommandSnapshot {
	command_id: string;
	command: string;
	cwd?: string;
	shell_mode: HeadlessUtilityCommandShellMode;
	pid?: number;
	output: string;
}

export class HeadlessUtilityCommandManager {
	private readonly commands = new Map<string, ActiveCommand>();

	constructor(
		private readonly emit: (event: HeadlessUtilityCommandEvent) => void,
	) {}

	snapshot(): HeadlessUtilityCommandSnapshot[] {
		return Array.from(this.commands.entries()).map(([command_id, active]) => ({
			command_id,
			command: active.command,
			cwd: active.cwd,
			shell_mode: active.shell_mode,
			pid: active.child.pid ?? undefined,
			output: active.output,
		}));
	}

	start(request: HeadlessUtilityCommandStartRequest): void {
		if (this.commands.has(request.command_id)) {
			throw new Error(`Utility command already exists: ${request.command_id}`);
		}

		const shellMode = request.shell_mode ?? "shell";
		const { resolvedCwd } = validateShellParams(
			request.command,
			request.cwd,
			request.env,
		);
		const env = request.env ? { ...process.env, ...request.env } : process.env;

		let child: ChildProcess;
		if (shellMode === "shell") {
			const { shell, args } = getShellConfig();
			child = spawn(shell, [...args, request.command], {
				cwd: resolvedCwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		} else {
			const parsed = parseCommandArguments(request.command);
			if (parsed.length === 0) {
				throw new Error("Command must contain an executable to run");
			}
			child = spawn(parsed[0]!, parsed.slice(1), {
				cwd: resolvedCwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
		}

		const active: ActiveCommand = {
			child,
			command: request.command,
			cwd: resolvedCwd,
			shell_mode: shellMode,
			output: "",
		};
		this.commands.set(request.command_id, active);
		this.emit({
			type: "started",
			command_id: request.command_id,
			command: request.command,
			cwd: resolvedCwd,
			shell_mode: shellMode,
			pid: child.pid ?? undefined,
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
