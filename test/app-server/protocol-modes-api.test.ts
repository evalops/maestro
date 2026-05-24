import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { MaestroAppServerResponseSchema } from "../../packages/contracts/src/maestro-app-server.js";
import {
	createMaestroAppServerSessionApi,
	handleMaestroAppServerRequest,
} from "../../src/app-server/session-api.js";
import { SessionManager } from "../../src/session/manager.js";

describe("Maestro app-server protocol modes", () => {
	let testDir: string | undefined;

	afterEach(() => {
		if (testDir) {
			rmSync(testDir, { recursive: true, force: true });
		}
		testDir = undefined;
	});

	function createApi(
		options: Parameters<typeof createMaestroAppServerSessionApi>[1] = {},
	) {
		testDir = join(tmpdir(), `maestro-app-server-protocol-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		return createMaestroAppServerSessionApi(
			new SessionManager(false, undefined, {
				sessionDir: join(testDir, "sessions"),
			}),
			options,
		);
	}

	it("lists standard, review, and realtime protocol modes", async () => {
		const api = createApi();
		expect(api.initialize()).toMatchObject({
			capabilities: {
				protocolModes: true,
			},
		});

		const listed = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "protocol-modes",
			method: "protocol/mode/list",
		});

		expect(listed.result).toMatchObject({
			activeMode: "standard",
			defaultMode: "standard",
			modes: expect.arrayContaining([
				expect.objectContaining({
					id: "review",
					readOnly: true,
					blockedMethods: expect.arrayContaining([
						"command/exec",
						"thread/delete",
					]),
				}),
				expect.objectContaining({
					id: "realtime",
					realtime: true,
					serverNotifications: ["fs/changed"],
				}),
			]),
		});
		expect(Value.Check(MaestroAppServerResponseSchema, listed)).toBe(true);
	});

	it("blocks mutating methods in review mode while allowing read-only methods", async () => {
		const api = createApi();

		const setReview = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "set-review",
			method: "protocol/mode/set",
			params: { mode: "review" },
		});
		expect(setReview.result).toMatchObject({
			activeMode: "review",
			mode: {
				readOnly: true,
				blockedMethods: expect.arrayContaining(["thread/name/set"]),
			},
		});
		expect(setReview.result?.mode.blockedMethods).not.toContain("fs/unwatch");
		expect(Value.Check(MaestroAppServerResponseSchema, setReview)).toBe(true);

		const models = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "model-list",
			method: "model/list",
		});
		expect(models.result).toHaveProperty("models");

		const blockedMutation = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "blocked-name-set",
			method: "thread/name/set",
			params: { threadId: "thread_1", name: "Renamed" },
		});
		expect(blockedMutation.error).toMatchObject({
			code: -32003,
			message: "thread/name/set is blocked while protocol mode is review",
		});

		const cleanupUnwatch = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "cleanup-unwatch",
			method: "fs/unwatch",
		});
		expect(cleanupUnwatch.error).toMatchObject({
			code: -32602,
			message: "Missing watchId",
		});

		await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "set-standard",
			method: "protocol/mode/set",
			params: { mode: "standard" },
		});
		const standardMutation = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "standard-name-set",
			method: "thread/name/set",
			params: { threadId: "thread_1", name: "Renamed" },
		});
		expect(standardMutation.error).toMatchObject({
			code: -32004,
			message: "Thread not found",
		});
	});

	it("rejects malformed protocol mode params", async () => {
		const api = createApi();

		const malformedList = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "malformed-list",
			method: "protocol/mode/list",
			params: [] as unknown as Record<string, unknown>,
		});
		expect(malformedList.error).toMatchObject({
			code: -32602,
			message: "Invalid params",
		});

		const malformedSet = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "malformed-set",
			method: "protocol/mode/set",
			params: [] as unknown as Record<string, unknown>,
		});
		expect(malformedSet.error).toMatchObject({
			code: -32602,
			message: "Invalid params",
		});

		const missingMode = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "missing-mode",
			method: "protocol/mode/set",
			params: {},
		});
		expect(missingMode.error).toMatchObject({
			code: -32602,
			message: "Missing mode",
		});

		const invalidMode = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "invalid-mode",
			method: "protocol/mode/set",
			params: { mode: "write" },
		});
		expect(invalidMode.error).toMatchObject({
			code: -32602,
			message: "Invalid mode",
		});
	});

	it("advertises realtime notifications and leaves realtime control methods dispatchable", async () => {
		const api = createApi({ onNotification: () => undefined });

		const setRealtime = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "set-realtime",
			method: "protocol/mode/set",
			params: { mode: "realtime" },
		});
		expect(setRealtime.result).toMatchObject({
			activeMode: "realtime",
			mode: {
				realtime: true,
				serverNotifications: ["fs/changed"],
			},
		});

		const watchWithoutPath = await handleMaestroAppServerRequest(api, {
			jsonrpc: "2.0",
			id: "watch-without-path",
			method: "fs/watch",
		});
		expect(watchWithoutPath.error).toMatchObject({
			code: -32602,
			message: "Missing watchId",
		});
	});
});
