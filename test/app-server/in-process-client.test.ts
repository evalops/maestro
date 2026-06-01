import { describe, expect, it } from "vitest";
import { maestroAppServerProtocolVersion } from "../../packages/contracts/src/maestro-app-server.js";
import {
	type MaestroAppServerClientInfo,
	createInProcessMaestroAppServerClient,
} from "../../src/app-server/in-process-client.js";
import type { MaestroAppServerSessionApi } from "../../src/app-server/session-api.js";

function createApi(overrides: Partial<MaestroAppServerSessionApi> = {}) {
	const api: MaestroAppServerSessionApi = {
		initialize: () => ({
			protocolVersion: maestroAppServerProtocolVersion,
			serverInfo: { name: "maestro" },
			capabilities: {
				sessions: true,
				modelList: true,
				modelProviderCapabilities: true,
				threadList: true,
				threadRead: true,
				threadMetadataUpdate: true,
				threadNameSet: true,
				threadGoals: true,
				threadStart: true,
				threadFork: true,
				threadArchive: true,
				threadDelete: true,
				turnsList: true,
			},
		}),
		listModels: async () => ({ models: [] }),
		readModelProviderCapabilities: async () => ({ providers: [] }),
		listThreads: async () => ({ threads: [], nextCursor: null }),
		readThread: async () => {
			throw new Error("not implemented");
		},
		updateThreadMetadata: async () => {
			throw new Error("not implemented");
		},
		setThreadName: async () => {
			throw new Error("not implemented");
		},
		getThreadGoal: async () => ({ threadId: "thread", goal: null }),
		setThreadGoal: async () => ({ threadId: "thread", goal: null }),
		clearThreadGoal: async () => ({ threadId: "thread", goal: null }),
		startThread: async () => {
			throw new Error("not implemented");
		},
		forkThread: async () => {
			throw new Error("not implemented");
		},
		archiveThread: async () => {
			throw new Error("not implemented");
		},
		unarchiveThread: async () => {
			throw new Error("not implemented");
		},
		deleteThread: async () => ({ threadId: "thread", deleted: true }),
		listTurns: async () => ({
			threadId: "thread",
			turns: [],
			nextCursor: null,
		}),
		...overrides,
	};
	return api;
}

const clientInfo: MaestroAppServerClientInfo = {
	name: "maestro_test",
	title: "Maestro Test",
	version: "0.0.0",
};

describe("in-process Maestro app-server client", () => {
	it("requires initialize before regular requests and rejects duplicate initialize", async () => {
		const client = createInProcessMaestroAppServerClient(createApi(), {
			clientInfo,
		});

		await expect(client.request("thread/list")).rejects.toMatchObject({
			code: -32000,
			message: "Not initialized",
		});

		await expect(client.initialize()).resolves.toMatchObject({
			protocolVersion: maestroAppServerProtocolVersion,
		});

		await expect(client.initialize()).rejects.toMatchObject({
			code: -32000,
			message: "Already initialized",
		});
		await expect(client.request("thread/list")).resolves.toMatchObject({
			threads: [],
			nextCursor: null,
		});
	});

	it("rejects concurrent initialize calls", async () => {
		const client = createInProcessMaestroAppServerClient(createApi(), {
			clientInfo,
		});

		const first = client.initialize();
		await expect(client.initialize()).rejects.toMatchObject({
			code: -32000,
			message: "Already initialized",
		});
		await expect(first).resolves.toMatchObject({
			protocolVersion: maestroAppServerProtocolVersion,
		});
	});

	it("returns explicit overload errors when the in-process request queue is saturated", async () => {
		let releaseList: (() => void) | undefined;
		const client = createInProcessMaestroAppServerClient(
			createApi({
				listThreads: async () => {
					await new Promise<void>((resolve) => {
						releaseList = resolve;
					});
					return { threads: [], nextCursor: null };
				},
			}),
			{ clientInfo, maxPendingRequests: 1 },
		);
		await client.initialize();

		const first = client.request("thread/list");
		const second = client.request("thread/list");

		await expect(second).rejects.toMatchObject({
			code: -32001,
			message: "Server overloaded; retry later.",
		});
		releaseList?.();
		await expect(first).resolves.toMatchObject({
			threads: [],
			nextCursor: null,
		});
	});
});
