import { existsSync, mkdirSync, rmSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import { createMaestroAppServerHostControl } from "../../src/app-server/host-control-api.js";
import { createInProcessMaestroAppServerClient } from "../../src/app-server/in-process-client.js";
import {
	type MaestroAppServerServerNotification,
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";

function waitForNotification(
	notifications: MaestroAppServerServerNotification[],
	predicate: (notification: MaestroAppServerServerNotification) => boolean,
): Promise<MaestroAppServerServerNotification> {
	const existing = notifications.find(predicate);
	if (existing) {
		return Promise.resolve(existing);
	}
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 2000;
		const timer = setInterval(() => {
			const next = notifications.find(predicate);
			if (next) {
				clearInterval(timer);
				resolve(next);
				return;
			}
			if (Date.now() > deadline) {
				clearInterval(timer);
				reject(new Error("Timed out waiting for app-server notification"));
			}
		}, 10);
		timer.unref?.();
	});
}

describe("Maestro app-server host-control API", () => {
	let testDir: string;
	let manager: SessionManager;
	const notifications: MaestroAppServerServerNotification[] = [];

	beforeEach(() => {
		testDir = join(tmpdir(), `maestro-app-server-host-control-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		manager = new SessionManager(false, undefined, { sessionDir: testDir });
		notifications.length = 0;
	});

	afterEach(() => {
		manager.disable();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("advertises explicit command, process, filesystem, and watch capabilities", () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});

		expect(api.initialize()).toMatchObject({
			capabilities: {
				commandExec: true,
				commandProcessControl: true,
				filesystem: true,
				filesystemWatch: true,
			},
		});
	});

	it("does not advertise or start filesystem watches without notification wiring", async () => {
		const api = createMaestroAppServerSessionApi(manager);
		const workspace = join(testDir, "workspace");
		mkdirSync(workspace, { recursive: true });

		expect(api.initialize()).toMatchObject({
			capabilities: {
				commandExec: true,
				filesystem: true,
				filesystemWatch: false,
			},
		});

		const watchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "watch-without-notifications",
			method: "fs/watch",
			params: { watchId: "source", path: workspace },
		});

		expect(watchResponse.error).toEqual({
			code: -32601,
			message: "Filesystem watch notifications are not available",
		});
	});

	it("routes host-control requests through the typed in-process client", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const client = createInProcessMaestroAppServerClient(api, {
			clientInfo: {
				name: "maestro_host_control_test",
				title: "Maestro Host Control Test",
				version: "0.0.0",
			},
		});

		await client.initialize();
		const execResult = await client.request("command/exec", {
			command: [process.execPath, "-e", "process.stdout.write('client-ok')"],
			cwd: testDir,
		});
		expect(execResult).toEqual({
			stdout: "client-ok",
			stderr: "",
			exitCode: 0,
		});

		const filePath = join(testDir, "client.txt");
		await expect(
			client.request("fs/writeFile", {
				path: filePath,
				dataBase64: Buffer.from("client-file").toString("base64"),
			}),
		).resolves.toEqual({});

		const readResult = await client.request("fs/readFile", { path: filePath });
		expect(Buffer.from(readResult.dataBase64, "base64").toString("utf8")).toBe(
			"client-file",
		);
	});

	it("runs commands through command/exec and can terminate a tracked process", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});

		const execResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "exec",
			method: "command/exec",
			params: {
				command: [process.execPath, "-e", "process.stdout.write('host-ok')"],
				cwd: testDir,
			},
		});

		expect(execResponse.result).toEqual({
			stdout: "host-ok",
			stderr: "",
			exitCode: 0,
		});
		expect(Value.Check(MaestroAppServerResponseSchema, execResponse)).toBe(
			true,
		);

		const longRunning = handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "long-running",
			method: "command/exec",
			params: {
				processId: "long-running",
				command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
				cwd: testDir,
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		const terminateResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "terminate",
			method: "command/exec/terminate",
			params: { processId: "long-running" },
		});

		expect(terminateResponse.result).toEqual({ processId: "long-running" });
		const completed = await longRunning;
		expect(completed.result).toMatchObject({
			stdout: "",
			stderr: "",
		});
		expect(
			(completed.result as { exitCode?: number } | undefined)?.exitCode,
		).not.toBe(0);
	});

	it("rejects whitespace-only process IDs before tracking commands", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "blank-process-id",
			method: "command/exec",
			params: {
				processId: "   ",
				command: [process.execPath, "-e", "process.stdout.write('unused')"],
				cwd: testDir,
			},
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "Missing processId",
		});
	});

	it("returns a controlled error for stdin writes after close", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const longRunning = handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "stdin-process",
			method: "command/exec",
			params: {
				processId: "stdin-process",
				command: [
					process.execPath,
					"-e",
					"process.stdin.resume(); setTimeout(() => {}, 10000)",
				],
				cwd: testDir,
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		const closeResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "close-stdin",
			method: "command/exec/write",
			params: { processId: "stdin-process", closeStdin: true },
		});
		expect(closeResponse.result).toEqual({ processId: "stdin-process" });

		const lateWrite = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "late-stdin-write",
			method: "command/exec/write",
			params: {
				processId: "stdin-process",
				deltaBase64: Buffer.from("late").toString("base64"),
			},
		});
		expect(lateWrite.error).toEqual({
			code: -32000,
			message: "Process stdin is closed",
		});

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "terminate-stdin-process",
			method: "command/exec/terminate",
			params: { processId: "stdin-process" },
		});
		const completed = await longRunning;
		expect(
			(completed.result as { exitCode?: number } | undefined)?.exitCode,
		).not.toBe(0);
	});

	it("rejects malformed base64 for stdin writes", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const longRunning = handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "malformed-stdin-process",
			method: "command/exec",
			params: {
				processId: "malformed-stdin-process",
				command: [
					process.execPath,
					"-e",
					"process.stdin.resume(); setTimeout(() => {}, 10000)",
				],
				cwd: testDir,
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "malformed-stdin-write",
			method: "command/exec/write",
			params: {
				processId: "malformed-stdin-process",
				deltaBase64: "not base64!",
			},
		});
		expect(response.error).toEqual({
			code: -32602,
			message: "deltaBase64 must be valid base64",
		});

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "terminate-malformed-stdin-process",
			method: "command/exec/terminate",
			params: { processId: "malformed-stdin-process" },
		});
		const completed = await longRunning;
		expect(
			(completed.result as { exitCode?: number } | undefined)?.exitCode,
		).not.toBe(0);
	});

	it("uses dedicated filesystem methods and emits fs/changed notifications", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const workspace = join(testDir, "workspace");
		const filePath = join(workspace, "note.txt");

		const mkdirResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "mkdir",
			method: "fs/createDirectory",
			params: { path: workspace },
		});
		expect(mkdirResponse.result).toEqual({});

		const watchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "watch",
			method: "fs/watch",
			params: { watchId: "source", path: workspace },
		});
		expect(watchResponse.result).toEqual({
			watchId: "source",
			path: workspace,
		});

		const writeResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "write",
			method: "fs/writeFile",
			params: {
				path: filePath,
				dataBase64: Buffer.from("hello file").toString("base64"),
			},
		});
		expect(writeResponse.result).toEqual({});

		const change = await waitForNotification(
			notifications,
			(notification) => notification.method === "fs/changed",
		);
		expect(change.params).toMatchObject({
			watchId: "source",
			changedPaths: [filePath],
		});

		const readResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "read",
			method: "fs/readFile",
			params: { path: filePath },
		});
		expect(readResponse.result).toEqual({
			dataBase64: Buffer.from("hello file").toString("base64"),
		});

		const listResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "list",
			method: "fs/readDirectory",
			params: { path: workspace },
		});
		expect(listResponse.result).toEqual({
			entries: [{ fileName: "note.txt", isDirectory: false, isFile: true }],
		});

		const metadataResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "metadata",
			method: "fs/getMetadata",
			params: { path: filePath },
		});
		expect(metadataResponse.result).toMatchObject({
			isFile: true,
			isDirectory: false,
			isSymlink: false,
		});

		const copyPath = join(workspace, "copy.txt");
		const copyResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "copy",
			method: "fs/copy",
			params: { sourcePath: filePath, destinationPath: copyPath },
		});
		expect(copyResponse.result).toEqual({});

		const removeResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "remove",
			method: "fs/remove",
			params: { path: copyPath },
		});
		expect(removeResponse.result).toEqual({});
		expect(existsSync(copyPath)).toBe(false);

		const unwatchResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "unwatch",
			method: "fs/unwatch",
			params: { watchId: "source" },
		});
		expect(unwatchResponse.result).toEqual({});
	});

	it("writes and reads zero-byte files through base64 payloads", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const emptyPath = join(testDir, "empty.bin");

		const writeResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "write-empty",
			method: "fs/writeFile",
			params: { path: emptyPath, dataBase64: "" },
		});
		expect(writeResponse.result).toEqual({});

		const readResponse = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "read-empty",
			method: "fs/readFile",
			params: { path: emptyPath },
		});
		expect(readResponse.result).toEqual({ dataBase64: "" });
	});

	it("rejects malformed base64 file writes before touching the target path", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});
		const malformedPath = join(testDir, "malformed.bin");

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "write-malformed-base64",
			method: "fs/writeFile",
			params: { path: malformedPath, dataBase64: "AA===" },
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "dataBase64 must be valid base64",
		});
		expect(existsSync(malformedPath)).toBe(false);
	});

	it("handles fs watcher error events without crashing unrelated sessions", async () => {
		const hostControl = createMaestroAppServerHostControl({
			onNotification: (notification) => notifications.push(notification),
		});
		await expect(
			hostControl.watch({ watchId: "unstable", path: testDir }),
		).resolves.toEqual({
			watchId: "unstable",
			path: testDir,
		});

		const tracked = (
			hostControl as unknown as {
				watchers: Map<string, { watcher: FSWatcher }>;
			}
		).watchers;
		const watcher = tracked.get("unstable")?.watcher;
		expect(watcher).toBeDefined();
		expect(() =>
			watcher?.emit("error", new Error("watch failed")),
		).not.toThrow();
		expect(tracked.has("unstable")).toBe(false);
		await expect(hostControl.unwatch({ watchId: "unstable" })).resolves.toEqual(
			{},
		);
		hostControl.dispose();
	});

	it("requires absolute host filesystem paths", async () => {
		const api = createMaestroAppServerSessionApi(manager, {
			onNotification: (notification) => notifications.push(notification),
		});

		const response = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "relative-read",
			method: "fs/readFile",
			params: { path: "relative.txt" },
		});

		expect(response.error).toEqual({
			code: -32602,
			message: "path must be an absolute path",
		});
	});
});
