import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	buildEvalOpsDelegationEnvironmentMock,
	getRegisteredModelsMock,
	issueEvalOpsDelegationTokenMock,
	spawnMock,
} = vi.hoisted(() => ({
	buildEvalOpsDelegationEnvironmentMock: vi.fn(),
	getRegisteredModelsMock: vi.fn(() => [{ id: "o3-mini", reasoning: true }]),
	issueEvalOpsDelegationTokenMock: vi.fn(),
	spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: spawnMock,
}));

vi.mock("../../src/models/registry.js", () => ({
	getRegisteredModels: getRegisteredModelsMock,
}));

vi.mock("../../src/oauth/index.js", () => ({
	buildEvalOpsDelegationEnvironment: buildEvalOpsDelegationEnvironmentMock,
	issueEvalOpsDelegationToken: issueEvalOpsDelegationTokenMock,
}));

import { oracleTool } from "../../src/tools/oracle.js";

function createMockChildProcess(output: string) {
	const proc = new EventEmitter() as EventEmitter & {
		stdout: EventEmitter;
		stderr: EventEmitter;
		pid: number;
		kill: ReturnType<typeof vi.fn>;
	};
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	proc.pid = 4242;
	proc.kill = vi.fn();

	setTimeout(() => {
		proc.stdout.emit("data", Buffer.from(output));
		proc.emit("close", 0);
	}, 0);

	return proc;
}

describe("oracleTool", () => {
	beforeEach(() => {
		buildEvalOpsDelegationEnvironmentMock.mockReset();
		buildEvalOpsDelegationEnvironmentMock.mockImplementation((result) => ({
			MAESTRO_EVALOPS_ACCESS_TOKEN: result.token,
			MAESTRO_EVALOPS_ORG_ID: result.organizationId,
			MAESTRO_EVALOPS_PROVIDER: result.providerRef.provider,
			MAESTRO_EVALOPS_ENVIRONMENT: result.providerRef.environment,
		}));
		spawnMock.mockReset();
		getRegisteredModelsMock.mockClear();
		issueEvalOpsDelegationTokenMock.mockReset();
		issueEvalOpsDelegationTokenMock.mockRejectedValue(
			new Error("Run /login evalops first."),
		);
		vi.unstubAllEnvs();
	});

	it("spawns the maestro CLI for seer runs", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("Foreseen."));

		const result = await oracleTool.execute("oracle-call", {
			task: "Review the architecture",
		});

		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.arrayContaining([
				"--read-only",
				"--tools",
				expect.any(String),
				"--model",
				"o3-mini",
				"--no-session",
				"exec",
				expect.stringContaining("seer-"),
			]),
			expect.objectContaining({
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		expect(result.content).toEqual([{ type: "text", text: "Foreseen." }]);
	});

	it("uses delegated EvalOps auth when available for seer runs", async () => {
		spawnMock.mockReturnValue(createMockChildProcess("Foreseen."));
		issueEvalOpsDelegationTokenMock.mockResolvedValue({
			agentId: "oracle-call",
			expiresAt: Date.now() + 60_000,
			organizationId: "org_evalops",
			providerRef: {
				provider: "gateway",
				environment: "prod",
			},
			runId: "oracle-call",
			scopesDenied: [],
			scopesGranted: ["llm_gateway:invoke"],
			scopesRequested: ["llm_gateway:invoke"],
			token: "delegated-token",
			tokenType: "Bearer",
		});
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "parent-token");

		await oracleTool.execute("oracle-call", {
			task: "Review the architecture",
		});

		expect(issueEvalOpsDelegationTokenMock).toHaveBeenCalledWith({
			agentId: "oracle-call",
			agentType: "oracle_seer",
			capabilities: ["oracle_read_only"],
			runId: "oracle-call",
			surface: "maestro-oracle",
			token: "parent-token",
			ttlSeconds: 120,
		});
		expect(buildEvalOpsDelegationEnvironmentMock).toHaveBeenCalled();
		expect(spawnMock).toHaveBeenCalledWith(
			"maestro",
			expect.any(Array),
			expect.objectContaining({
				env: expect.objectContaining({
					MAESTRO_EVALOPS_ACCESS_TOKEN: "delegated-token",
					MAESTRO_EVALOPS_ORG_ID: "org_evalops",
					MAESTRO_EVALOPS_PROVIDER: "gateway",
					MAESTRO_EVALOPS_ENVIRONMENT: "prod",
				}),
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
	});
});
