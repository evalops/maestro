import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleA2ACommand,
	isA2AWaitCompletionState,
	parseA2AArgs,
} from "../../../src/cli/commands/a2a.js";

interface AgentRegistryCall {
	operation: string;
	body: Record<string, unknown>;
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> {
	if (typeof body !== "string") {
		return {};
	}
	return JSON.parse(body) as Record<string, unknown>;
}

function stubAgentRegistryEnv(): void {
	vi.stubEnv("AGENT_REGISTRY_SERVICE_URL", "https://registry.test/");
	vi.stubEnv("AGENT_REGISTRY_SERVICE_TOKEN", "registry-token");
	vi.stubEnv("AGENT_REGISTRY_ORGANIZATION_ID", "org_1");
	vi.stubEnv("AGENT_REGISTRY_WORKSPACE_ID", "ws_1");
}

function muteConsole(): void {
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
}

function mockAgentRegistryFetch(): AgentRegistryCall[] {
	const calls: AgentRegistryCall[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const operation = url.split("/").pop() ?? "";
			const body = parseRequestBody(init?.body);
			calls.push({ operation, body });
			if (operation === "Register" || operation === "Update") {
				return new Response(
					JSON.stringify({
						agent: {
							id: body.id ?? "maestro-peer-1",
							name: body.name ?? "Maestro Peer",
							a2a: body.a2a,
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (operation === "Heartbeat") {
				return new Response(
					JSON.stringify({ nextHeartbeatBy: "2026-05-19T10:05:00Z" }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			return new Response(JSON.stringify({ code: "not_found" }), {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		}),
	);
	return calls;
}

describe("A2A CLI command helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
	});

	it("preserves unknown -- tokens as message text", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"review",
			"--help",
			"and",
			"--dry-run",
		]);
		expect(parsed.flags.has("--help")).toBe(false);
		expect(parsed.flags.has("--dry-run")).toBe(false);
	});

	it("preserves known option-looking text after an explicit delimiter", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"--",
			"--wait",
			"--timeout-ms=1000",
		]);

		expect(parsed.positionals).toEqual([
			"send",
			"mac-mini",
			"--wait",
			"--timeout-ms=1000",
		]);
		expect(parsed.flags.size).toBe(0);
	});

	it("still parses known send flags", () => {
		const parsed = parseA2AArgs([
			"send",
			"mac-mini",
			"ping",
			"--wait",
			"--work-graph",
			"--timeout-ms",
			"1000",
		]);

		expect(parsed.positionals).toEqual(["send", "mac-mini", "ping"]);
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--work-graph")).toBe(true);
		expect(parsed.flags.get("--timeout-ms")).toBe("1000");
	});

	it("parses Platform-discovered delegate flags without swallowing task text", () => {
		const parsed = parseA2AArgs([
			"delegate",
			"--discover",
			"--skill",
			"maestro.subagent.code-review",
			"--capability",
			"code:review",
			"--workspace-id",
			"ws_1",
			"--surface",
			"maestro",
			"--prefer-internal",
			"review",
			"the",
			"patch",
			"--wait",
		]);

		expect(parsed.positionals).toEqual(["delegate", "review", "the", "patch"]);
		expect(parsed.flags.get("--discover")).toBe(true);
		expect(parsed.flags.get("--skill")).toBe("maestro.subagent.code-review");
		expect(parsed.flags.get("--capability")).toBe("code:review");
		expect(parsed.flags.get("--workspace-id")).toBe("ws_1");
		expect(parsed.flags.get("--surface")).toBe("maestro");
		expect(parsed.flags.get("--prefer-internal")).toBe(true);
		expect(parsed.flags.get("--wait")).toBe(true);
	});

	it("parses Platform-backed peer discovery flags", () => {
		const parsed = parseA2AArgs([
			"discover",
			"--capability",
			"code:review",
			"--skill",
			"maestro.subagent.code-review",
			"--status",
			"AGENT_STATUS_ONLINE",
			"--workspace-id",
			"ws_1",
			"--limit",
			"25",
			"--offset",
			"0",
			"--import",
			"--default",
			"--prefer-internal",
			"--json",
		]);

		expect(parsed.positionals).toEqual(["discover"]);
		expect(parsed.flags.get("--capability")).toBe("code:review");
		expect(parsed.flags.get("--skill")).toBe("maestro.subagent.code-review");
		expect(parsed.flags.get("--status")).toBe("AGENT_STATUS_ONLINE");
		expect(parsed.flags.get("--workspace-id")).toBe("ws_1");
		expect(parsed.flags.get("--limit")).toBe("25");
		expect(parsed.flags.get("--offset")).toBe("0");
		expect(parsed.flags.get("--import")).toBe(true);
		expect(parsed.flags.get("--default")).toBe(true);
		expect(parsed.flags.get("--prefer-internal")).toBe(true);
		expect(parsed.flags.get("--json")).toBe(true);
	});

	it("parses Platform A2A peer registration flags", () => {
		const parsed = parseA2AArgs([
			"register",
			"--url",
			"https://maestro.example/a2a",
			"--internal-url",
			"http://maestro.evalops.svc/a2a",
			"--agent-card-url",
			"https://maestro.example/.well-known/agent-card.json",
			"--agent-id",
			"maestro-peer-1",
			"--workspace-id",
			"ws_1",
			"--capabilities",
			"maestro:a2a,code:review",
			"--surface-types",
			"SURFACE_MAESTRO",
			"--status",
			"AGENT_STATUS_IDLE",
			"--json",
		]);

		expect(parsed.positionals).toEqual(["register"]);
		expect(parsed.flags.get("--url")).toBe("https://maestro.example/a2a");
		expect(parsed.flags.get("--internal-url")).toBe(
			"http://maestro.evalops.svc/a2a",
		);
		expect(parsed.flags.get("--agent-card-url")).toBe(
			"https://maestro.example/.well-known/agent-card.json",
		);
		expect(parsed.flags.get("--agent-id")).toBe("maestro-peer-1");
		expect(parsed.flags.get("--workspace-id")).toBe("ws_1");
		expect(parsed.flags.get("--capabilities")).toBe("maestro:a2a,code:review");
		expect(parsed.flags.get("--surface-types")).toBe("SURFACE_MAESTRO");
		expect(parsed.flags.get("--status")).toBe("AGENT_STATUS_IDLE");
		expect(parsed.flags.get("--json")).toBe(true);
	});

	it("routes the Platform A2A publish alias through registration", async () => {
		stubAgentRegistryEnv();
		muteConsole();
		const calls = mockAgentRegistryFetch();

		await handleA2ACommand([
			"publish",
			"--url",
			"https://maestro.example/a2a",
			"--agent-id",
			"maestro-peer-1",
			"--name",
			"Maestro Peer",
			"--json",
		]);

		expect(calls.map((call) => call.operation)).toEqual([
			"Register",
			"Heartbeat",
		]);
		expect(calls[0]?.body).toMatchObject({
			id: "maestro-peer-1",
			name: "Maestro Peer",
			surfaces: ["a2a", "maestro"],
			surfaceTypes: ["SURFACE_MAESTRO"],
			a2a: expect.objectContaining({
				publicEndpointUrl: "https://maestro.example/a2a",
			}),
		});
		expect(calls[1]?.body).toMatchObject({
			agentId: "maestro-peer-1",
			status: "AGENT_STATUS_IDLE",
			surface: "a2a",
			surfaceType: "SURFACE_MAESTRO",
		});
	});

	it("allows heartbeat-only Platform A2A registration without a public URL", async () => {
		stubAgentRegistryEnv();
		muteConsole();
		const calls = mockAgentRegistryFetch();

		await handleA2ACommand([
			"register",
			"--heartbeat-only",
			"--agent-id",
			"maestro-peer-1",
			"--json",
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			operation: "Heartbeat",
			body: {
				agentId: "maestro-peer-1",
				status: "AGENT_STATUS_IDLE",
				surface: "a2a",
				surfaceType: "SURFACE_MAESTRO",
			},
		});
		expect(calls[0]?.body).not.toHaveProperty("a2a");
	});

	it("rejects heartbeat-only registration when heartbeat is disabled", async () => {
		await expect(
			handleA2ACommand([
				"register",
				"--heartbeat-only",
				"--no-heartbeat",
				"--agent-id",
				"maestro-peer-1",
			]),
		).rejects.toThrow(
			"--heartbeat-only cannot be combined with --no-heartbeat",
		);
	});

	it("parses direct task output work graph flags", () => {
		const reply = parseA2AArgs([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"the",
			"short",
			"smoke",
			"--work-graph",
		]);
		expect(reply.positionals).toEqual([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"the",
			"short",
			"smoke",
		]);
		expect(reply.flags.get("--work-graph")).toBe(true);

		const wait = parseA2AArgs(["wait", "mac-mini", "task-1", "--work-graph"]);
		expect(wait.positionals).toEqual(["wait", "mac-mini", "task-1"]);
		expect(wait.flags.get("--work-graph")).toBe(true);
	});

	it("parses task reply flags without swallowing reply text", () => {
		const parsed = parseA2AArgs([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"--json",
			"--wait",
			"--tasks",
			"/tmp/tasks.json",
		]);

		expect(parsed.positionals).toEqual([
			"reply",
			"mac-mini",
			"task-1",
			"use",
			"--json",
		]);
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--tasks")).toBe("/tmp/tasks.json");
	});

	it("scopes json and refresh flags to fleet task views", () => {
		const delegate = parseA2AArgs([
			"delegate",
			"mac-mini",
			"emit",
			"--json",
			"--refresh",
		]);
		expect(delegate.positionals).toEqual([
			"delegate",
			"mac-mini",
			"emit",
			"--json",
			"--refresh",
		]);
		expect(delegate.flags.size).toBe(0);

		const tasks = parseA2AArgs(["tasks", "--json", "--refresh"]);
		expect(tasks.positionals).toEqual(["tasks"]);
		expect(tasks.flags.get("--json")).toBe(true);
		expect(tasks.flags.get("--refresh")).toBe(true);

		const workGraph = parseA2AArgs(["tasks", "mac-mini", "--work-graph"]);
		expect(workGraph.positionals).toEqual(["tasks", "mac-mini"]);
		expect(workGraph.flags.get("--work-graph")).toBe(true);
	});

	it("parses coordinate flags without swallowing reply text", () => {
		const parsed = parseA2AArgs([
			"coordinate",
			"mac-mini",
			"--refresh",
			"--reply",
			"use",
			"the",
			"short",
			"smoke",
			"--wait",
			"--json",
			"--tasks",
			"/tmp/tasks.json",
		]);

		expect(parsed.positionals).toEqual(["coordinate", "mac-mini"]);
		expect(parsed.flags.get("--refresh")).toBe(true);
		expect(parsed.flags.get("--reply")).toBe("use the short smoke");
		expect(parsed.flags.get("--wait")).toBe(true);
		expect(parsed.flags.get("--json")).toBe(true);
		expect(parsed.flags.get("--tasks")).toBe("/tmp/tasks.json");
	});

	it("rejects coordinate reply flags without reply text", () => {
		expect(() =>
			parseA2AArgs(["coordinate", "mac-mini", "--reply", "--wait"]),
		).toThrow("--reply requires text");
		expect(() => parseA2AArgs(["coordinate", "mac-mini", "--reply="])).toThrow(
			"Usage: maestro a2a coordinate [peer] --reply <text> [--wait]",
		);
	});

	it("parses leading flags after locating the subcommand", () => {
		const parsed = parseA2AArgs(["--registry", "/tmp/peers.json", "peers"]);

		expect(parsed.positionals).toEqual(["peers"]);
		expect(parsed.flags.get("--registry")).toBe("/tmp/peers.json");
	});

	it("ignores leading flags from other subcommands during dispatch", () => {
		const delegate = parseA2AArgs([
			"--json",
			"delegate",
			"mac-mini",
			"do",
			"stuff",
		]);

		expect(delegate.positionals).toEqual([
			"delegate",
			"mac-mini",
			"do",
			"stuff",
		]);
		expect(delegate.flags.size).toBe(0);

		const peers = parseA2AArgs(["--timeout-ms", "1000", "peers"]);
		expect(peers.positionals).toEqual(["peers"]);
		expect(peers.flags.size).toBe(0);
	});

	it("treats actionable A2A states as wait completion", () => {
		expect(isA2AWaitCompletionState("completed")).toBe(true);
		expect(isA2AWaitCompletionState("input-required")).toBe(true);
		expect(isA2AWaitCompletionState("AUTH_REQUIRED")).toBe(true);
		expect(isA2AWaitCompletionState("working")).toBe(false);
		expect(isA2AWaitCompletionState("submitted")).toBe(false);
	});
});
