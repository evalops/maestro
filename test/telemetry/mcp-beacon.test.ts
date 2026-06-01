import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("MCP telemetry beacons", () => {
	let tempDir: string;
	let beaconFile: string;

	beforeEach(async () => {
		vi.resetModules();
		tempDir = await mkdtemp(join(tmpdir(), "maestro-mcp-beacon-"));
		beaconFile = join(tempDir, "beacon.jsonl");
		vi.stubEnv("MAESTRO_TELEMETRY", "1");
		vi.stubEnv("MAESTRO_BEACON_FILE", beaconFile);
		vi.stubEnv("MAESTRO_VERSION", "0.10.18-test");
	});

	afterEach(async () => {
		vi.resetModules();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(tempDir, { recursive: true, force: true });
	});

	it("writes sparse local connection metadata without process details", async () => {
		const { emitMcpConnectionBeacon } = await import(
			"../../src/telemetry/mcp-beacon.js"
		);

		await emitMcpConnectionBeacon({
			serverName: "local-tools",
			transport: "stdio",
			toolCount: 2,
			resourceCount: 1,
			promptCount: 0,
		});

		const [event] = await readBeaconEvents(beaconFile);

		expect(event).toMatchObject({
			feature: "mcp.connection",
			action: "localConnected",
			source: {
				client: "cli",
				clientVersion: "0.10.18-test",
				surface: "mcp",
			},
			parameters: {
				metadata: {
					serverName: "local-tools",
					transport: "stdio",
					toolCount: 2,
					resourceCount: 1,
					promptCount: 0,
					reconnect: false,
				},
			},
		});
		expect(event.parameters.metadata).not.toHaveProperty("command");
		expect(event.parameters.metadata).not.toHaveProperty("args");
		expect(event.parameters.metadata).not.toHaveProperty("env");
	});

	it("writes compact capability counts for tool-confusion telemetry", async () => {
		const { emitMcpConnectionBeacon } = await import(
			"../../src/telemetry/mcp-beacon.js"
		);

		await emitMcpConnectionBeacon({
			serverName: "fathom-cua",
			transport: "stdio",
			toolCount: 18,
			resourceCount: 0,
			promptCount: 0,
			toolCapabilitySummary: {
				total: 18,
				byDomain: {
					desktop: 18,
					file: 0,
					shell: 0,
					web: 0,
					mcp: 0,
					unknown: 0,
				},
				byRiskClass: { observe: 4, low: 0, medium: 14, high: 0 },
				byToolLane: {
					desktop_observe: 4,
					desktop_action: 14,
					file_read: 0,
					file_edit: 0,
					shell_exec: 0,
					web_access: 0,
					mcp_meta: 0,
					unknown: 0,
				},
				mutating: { desktop: 14, files: 0 },
				requiresReceipt: 18,
				rawSecretPossible: 4,
			},
		});

		const [event] = await readBeaconEvents(beaconFile);

		expect(event.parameters.metadata).toMatchObject({
			serverName: "fathom-cua",
			desktopToolCount: 18,
			desktopActionToolCount: 14,
			fileEditToolCount: 0,
			highRiskToolCount: 0,
			receiptBackedToolCount: 18,
			rawSecretPossibleToolCount: 4,
		});
	});

	it("writes remote tool usage metadata without URL, args, or output", async () => {
		const { emitMcpToolUsageBeacon } = await import(
			"../../src/telemetry/mcp-beacon.js"
		);

		await emitMcpToolUsageBeacon({
			serverName: "remote-tools",
			transport: "http",
			remoteHost: "mcp.example.test",
			toolName: "search",
		});

		const [event] = await readBeaconEvents(beaconFile);

		expect(event).toMatchObject({
			feature: "mcp.toolUsage",
			action: "remoteToolCalled",
			parameters: {
				metadata: {
					serverName: "remote-tools",
					transport: "http",
					remoteHost: "mcp.example.test",
					toolName: "search",
				},
			},
		});
		expect(event.parameters.metadata).not.toHaveProperty("url");
		expect(event.parameters.metadata).not.toHaveProperty("args");
		expect(event.parameters.metadata).not.toHaveProperty("content");
		expect(event.parameters.metadata).not.toHaveProperty("structuredContent");
	});

	it("respects telemetry opt-out", async () => {
		vi.stubEnv("MAESTRO_TELEMETRY", "0");
		const { emitMcpToolUsageBeacon } = await import(
			"../../src/telemetry/mcp-beacon.js"
		);

		const emitted = await emitMcpToolUsageBeacon({
			serverName: "remote-tools",
			transport: "sse",
			remoteHost: "mcp.example.test",
			toolName: "search",
		});

		expect(emitted).toBe(false);
		await expect(readFile(beaconFile, "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

async function readBeaconEvents(file: string): Promise<
	Array<{
		feature: string;
		action: string;
		source: Record<string, unknown>;
		parameters: { metadata: Record<string, unknown> };
	}>
> {
	const lines = (await readFile(file, "utf8")).trim().split("\n");
	return lines.flatMap((line) => JSON.parse(line));
}
