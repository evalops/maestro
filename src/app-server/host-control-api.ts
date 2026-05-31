import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import {
	copyFile,
	cp,
	lstat,
	mkdir,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type {
	MaestroAppServerCommandExecResult,
	MaestroAppServerCommandProcessResult,
	MaestroAppServerEmptyResult,
	MaestroAppServerFsMetadataResult,
	MaestroAppServerFsReadDirectoryResult,
	MaestroAppServerFsReadFileResult,
	MaestroAppServerFsWatchResult,
	MaestroAppServerServerNotification,
} from "@evalops/contracts";

export class MaestroAppServerHostControlError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "MaestroAppServerHostControlError";
	}
}

export interface MaestroAppServerHostControlOptions {
	onNotification?: (notification: MaestroAppServerServerNotification) => void;
}

type TrackedProcess = {
	processId: string;
	child: ChildProcessWithoutNullStreams;
	stdinClosed: boolean;
	stdinError?: string;
};

type TrackedWatcher = {
	watcher: FSWatcher;
};

function hasOwn(object: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

function paramsObject(params: Record<string, unknown> | undefined) {
	return params ?? {};
}

function requireString(value: unknown, name: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new MaestroAppServerHostControlError(-32602, `Missing ${name}`);
	}
	return value;
}

function optionalString(value: unknown, name: string): string | undefined {
	if (value === undefined || value === null || value === "") {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be a string`,
		);
	}
	if (value.trim() === "") {
		throw new MaestroAppServerHostControlError(-32602, `Missing ${name}`);
	}
	return value;
}

function requireAbsolutePath(value: unknown, name: string): string {
	const path = requireString(value, name);
	if (!isAbsolute(path)) {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be an absolute path`,
		);
	}
	return resolve(path);
}

function optionalAbsolutePath(
	value: unknown,
	name: string,
): string | undefined {
	const path = optionalString(value, name);
	if (path === undefined) {
		return undefined;
	}
	if (!isAbsolute(path)) {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be an absolute path`,
		);
	}
	return resolve(path);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== "boolean") {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be a boolean`,
		);
	}
	return value;
}

function requireCommand(value: unknown): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.some((part) => typeof part !== "string" || part.length === 0)
	) {
		throw new MaestroAppServerHostControlError(
			-32602,
			"command must be a non-empty string array",
		);
	}
	return [...value];
}

function optionalEnv(value: unknown): NodeJS.ProcessEnv {
	if (value === undefined || value === null) {
		return { ...process.env };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new MaestroAppServerHostControlError(-32602, "env must be an object");
	}
	const env = { ...process.env };
	for (const [key, rawValue] of Object.entries(value)) {
		if (rawValue === null) {
			delete env[key];
			continue;
		}
		if (typeof rawValue !== "string") {
			throw new MaestroAppServerHostControlError(
				-32602,
				"env values must be strings or null",
			);
		}
		env[key] = rawValue;
	}
	return env;
}

function decodeBase64(value: unknown, name: string): Buffer {
	if (value === undefined || value === null) {
		throw new MaestroAppServerHostControlError(-32602, `Missing ${name}`);
	}
	if (typeof value !== "string") {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be a string`,
		);
	}
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be valid base64`,
		);
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) {
		throw new MaestroAppServerHostControlError(
			-32602,
			`${name} must be canonical base64`,
		);
	}
	return decoded;
}

function exitCodeFromSignal(signal: NodeJS.Signals | null): number {
	if (signal === "SIGTERM") return 143;
	if (signal === "SIGKILL") return 137;
	return 1;
}

export class MaestroAppServerHostControl {
	private readonly processes = new Map<string, TrackedProcess>();
	private readonly watchers = new Map<string, TrackedWatcher>();

	constructor(
		private readonly options: MaestroAppServerHostControlOptions = {},
	) {}

	supportsWatch(): boolean {
		return Boolean(this.options.onNotification);
	}

	async execCommand(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandExecResult> {
		const input = paramsObject(params);
		const command = requireCommand(input.command);
		const cwd = optionalAbsolutePath(input.cwd, "cwd") ?? process.cwd();
		const env = optionalEnv(input.env);
		const processId = optionalString(input.processId, "processId");
		if (processId && this.processes.has(processId)) {
			throw new MaestroAppServerHostControlError(
				-32602,
				`processId already exists: ${processId}`,
			);
		}

		const child = spawn(command[0]!, command.slice(1), {
			cwd,
			env,
			stdio: "pipe",
			windowsHide: true,
		});
		if (processId) {
			const tracked: TrackedProcess = {
				processId,
				child,
				stdinClosed: child.stdin.destroyed || child.stdin.writableEnded,
			};
			child.stdin.on("finish", () => {
				tracked.stdinClosed = true;
			});
			child.stdin.on("close", () => {
				tracked.stdinClosed = true;
			});
			child.stdin.on("error", (error) => {
				tracked.stdinClosed = true;
				tracked.stdinError =
					error instanceof Error ? error.message : String(error);
			});
			this.processes.set(processId, tracked);
		}

		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

		return new Promise((resolvePromise, reject) => {
			let settled = false;
			const finish = (
				result:
					| { code: number | null; signal: NodeJS.Signals | null }
					| { error: Error },
			) => {
				if (settled) return;
				settled = true;
				if (processId) {
					this.processes.delete(processId);
				}
				if ("error" in result) {
					reject(
						new MaestroAppServerHostControlError(-32000, result.error.message),
					);
					return;
				}
				resolvePromise({
					stdout: Buffer.concat(stdout).toString("utf8"),
					stderr: Buffer.concat(stderr).toString("utf8"),
					exitCode: result.code ?? exitCodeFromSignal(result.signal),
				});
			};
			child.on("error", (error) => finish({ error }));
			child.on("close", (code, signal) => finish({ code, signal }));
		});
	}

	async writeCommandStdin(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandProcessResult> {
		const input = paramsObject(params);
		const processId = requireString(input.processId, "processId");
		const tracked = this.processes.get(processId);
		if (!tracked) {
			throw new MaestroAppServerHostControlError(-32004, "Process not found");
		}
		if (hasOwn(input, "deltaBase64") && input.deltaBase64 !== null) {
			if (
				tracked.stdinClosed ||
				tracked.child.stdin.destroyed ||
				tracked.child.stdin.writableEnded
			) {
				throw new MaestroAppServerHostControlError(
					-32000,
					tracked.stdinError ?? "Process stdin is closed",
				);
			}
			try {
				tracked.child.stdin.write(
					decodeBase64(input.deltaBase64, "deltaBase64"),
				);
			} catch (error) {
				if (error instanceof MaestroAppServerHostControlError) {
					throw error;
				}
				tracked.stdinClosed = true;
				tracked.stdinError =
					error instanceof Error ? error.message : "Process stdin write failed";
				throw new MaestroAppServerHostControlError(-32000, tracked.stdinError);
			}
		}
		if (optionalBoolean(input.closeStdin, "closeStdin") === true) {
			tracked.stdinClosed = true;
			tracked.child.stdin.end();
		}
		return { processId };
	}

	async terminateCommand(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerCommandProcessResult> {
		const processId = requireString(
			paramsObject(params).processId,
			"processId",
		);
		const tracked = this.processes.get(processId);
		if (!tracked) {
			throw new MaestroAppServerHostControlError(-32004, "Process not found");
		}
		tracked.child.kill("SIGTERM");
		return { processId };
	}

	async readFile(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsReadFileResult> {
		const path = requireAbsolutePath(paramsObject(params).path, "path");
		return { dataBase64: (await readFile(path)).toString("base64") };
	}

	async writeFile(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult> {
		const input = paramsObject(params);
		const path = requireAbsolutePath(input.path, "path");
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, decodeBase64(input.dataBase64, "dataBase64"));
		return {};
	}

	async readDirectory(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsReadDirectoryResult> {
		const path = requireAbsolutePath(paramsObject(params).path, "path");
		const entries = await readdir(path, { withFileTypes: true });
		return {
			entries: entries
				.map((entry) => ({
					fileName: entry.name,
					isDirectory: entry.isDirectory(),
					isFile: entry.isFile(),
				}))
				.sort((left, right) => left.fileName.localeCompare(right.fileName)),
		};
	}

	async getMetadata(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsMetadataResult> {
		const path = requireAbsolutePath(paramsObject(params).path, "path");
		const stats = await lstat(path);
		return {
			createdAtMs: Math.trunc(stats.birthtimeMs),
			modifiedAtMs: Math.trunc(stats.mtimeMs),
			isDirectory: stats.isDirectory(),
			isFile: stats.isFile(),
			isSymlink: stats.isSymbolicLink(),
		};
	}

	async createDirectory(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult> {
		const input = paramsObject(params);
		const path = requireAbsolutePath(input.path, "path");
		await mkdir(path, {
			recursive: optionalBoolean(input.recursive, "recursive") ?? true,
		});
		return {};
	}

	async remove(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult> {
		const input = paramsObject(params);
		const path = requireAbsolutePath(input.path, "path");
		await rm(path, {
			recursive: optionalBoolean(input.recursive, "recursive") ?? true,
			force: optionalBoolean(input.force, "force") ?? true,
		});
		return {};
	}

	async copy(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult> {
		const input = paramsObject(params);
		const sourcePath = requireAbsolutePath(input.sourcePath, "sourcePath");
		const destinationPath = requireAbsolutePath(
			input.destinationPath,
			"destinationPath",
		);
		const recursive = optionalBoolean(input.recursive, "recursive") ?? false;
		if (recursive) {
			await cp(sourcePath, destinationPath, { recursive: true });
		} else {
			await copyFile(sourcePath, destinationPath);
		}
		return {};
	}

	async watch(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerFsWatchResult> {
		if (!this.supportsWatch()) {
			throw new MaestroAppServerHostControlError(
				-32601,
				"Filesystem watch notifications are not available",
			);
		}
		const input = paramsObject(params);
		const watchId = requireString(input.watchId, "watchId");
		const path = requireAbsolutePath(input.path, "path");
		if (this.watchers.has(watchId)) {
			throw new MaestroAppServerHostControlError(
				-32602,
				`watchId already exists: ${watchId}`,
			);
		}
		const stats = await lstat(path);
		const isDirectory = stats.isDirectory();
		const watcher = watch(
			path,
			{ persistent: false },
			(_eventType, filename) => {
				const changedPath =
					isDirectory && filename ? resolve(path, filename.toString()) : path;
				this.options.onNotification?.({
					jsonrpc: "2.0",
					method: "fs/changed",
					params: {
						watchId,
						changedPaths: [changedPath],
					},
				});
			},
		);
		watcher.on("error", () => {
			this.watchers.delete(watchId);
			watcher.close();
		});
		watcher.unref?.();
		this.watchers.set(watchId, { watcher });
		return { watchId, path };
	}

	async unwatch(
		params?: Record<string, unknown>,
	): Promise<MaestroAppServerEmptyResult> {
		const watchId = requireString(paramsObject(params).watchId, "watchId");
		const tracked = this.watchers.get(watchId);
		if (tracked) {
			tracked.watcher.close();
			this.watchers.delete(watchId);
		}
		return {};
	}

	dispose(): void {
		for (const { child } of this.processes.values()) {
			child.kill("SIGTERM");
		}
		this.processes.clear();
		for (const { watcher } of this.watchers.values()) {
			watcher.close();
		}
		this.watchers.clear();
	}
}

export function createMaestroAppServerHostControl(
	options?: MaestroAppServerHostControlOptions,
): MaestroAppServerHostControl {
	return new MaestroAppServerHostControl(options);
}
