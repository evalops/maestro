import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recallRemoteDurableMemories } from "../../src/memory/service-client.js";
import {
	PLATFORM_CONNECT_METHODS,
	PLATFORM_HTTP_ROUTES,
	platformConnectMethodPath,
} from "../../src/platform/core-services.js";
import { resolvePromptTemplate } from "../../src/prompts/service-client.js";
import {
	hasRemoteMeterDestination,
	mirrorCanonicalTurnEventToMeter,
} from "../../src/telemetry/meter-service-client.js";
import { TurnCollector } from "../../src/telemetry/wide-events.js";

const PROMPTS_RESOLVE_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.prompts.resolve,
);
const METER_INGEST_WIDE_EVENT_PATH = platformConnectMethodPath(
	PLATFORM_CONNECT_METHODS.meter.ingestWideEvent,
);
const MEMORY_RECALL_PATH = PLATFORM_HTTP_ROUTES.memory.recall;

type CapturedRequest = {
	body?: Record<string, unknown>;
	headers: Record<string, string>;
	method?: string;
	pathname: string;
	url: string;
};

function headersToRecord(
	headers: HeadersInit | undefined,
): Record<string, string> {
	return Object.fromEntries(new Headers(headers).entries());
}

function parseRequestBody(
	body: BodyInit | null | undefined,
): Record<string, unknown> | undefined {
	return typeof body === "string"
		? (JSON.parse(body) as Record<string, unknown>)
		: undefined;
}

function createCanonicalTurnEvent() {
	return new TurnCollector("session-platform-smoke", 1)
		.setModel({
			id: "gpt-5.4",
			provider: "openai",
			thinkingLevel: "medium",
		})
		.setSandboxMode("workspace-write")
		.setApprovalMode("on-request")
		.complete(
			"success",
			{
				input: 42,
				output: 21,
				cacheRead: 2,
				cacheWrite: 1,
			},
			0.04,
		);
}

describe("Platform core service integration smoke", () => {
	let repoRoot: string;

	beforeEach(() => {
		repoRoot = mkdtempSync(join(tmpdir(), "maestro-platform-smoke-"));
		execSync("git init -b main", {
			cwd: repoRoot,
			stdio: "ignore",
		});

		for (const name of [
			"PROMPTS_SERVICE_URL",
			"PROMPTS_SERVICE_TOKEN",
			"PROMPTS_SERVICE_ORGANIZATION_ID",
			"MAESTRO_PROMPTS_SERVICE_URL",
			"MAESTRO_PROMPTS_SERVICE_TOKEN",
			"MAESTRO_PROMPTS_ORGANIZATION_ID",
			"MAESTRO_MEMORY_BASE",
			"MAESTRO_MEMORY_ACCESS_TOKEN",
			"MAESTRO_MEMORY_ORGANIZATION_ID",
			"MAESTRO_METER_BASE",
			"MAESTRO_METER_ACCESS_TOKEN",
			"MAESTRO_METER_ORGANIZATION_ID",
		]) {
			vi.stubEnv(name, "");
		}

		vi.stubEnv("PROMPTS_SERVICE_TRANSPORT", "connect");
		vi.stubEnv("MAESTRO_PLATFORM_BASE_URL", "http://platform-smoke.test/");
		vi.stubEnv("MAESTRO_EVALOPS_ACCESS_TOKEN", "platform-token");
		vi.stubEnv("MAESTRO_EVALOPS_ORG_ID", "org_platform");
		vi.stubEnv("MAESTRO_EVALOPS_TEAM_ID", "team_platform");
		vi.stubEnv("MAESTRO_AGENT_ID", "maestro-smoke");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(repoRoot, { recursive: true, force: true });
	});

	it("drives prompts, memory, and meter from shared Platform configuration", async () => {
		const requests: CapturedRequest[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const parsed = new URL(url);
				const request = {
					body: parseRequestBody(init?.body),
					headers: headersToRecord(init?.headers),
					method: init?.method,
					pathname: parsed.pathname,
					url,
				};
				requests.push(request);

				if (parsed.pathname === PROMPTS_RESOLVE_PATH) {
					return new Response(
						JSON.stringify({
							version: {
								id: "ver_smoke_1",
								version: 1,
								content: "Platform smoke prompt",
							},
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (parsed.pathname === MEMORY_RECALL_PATH) {
					return new Response(
						JSON.stringify({
							query: request.body?.query,
							total: 1,
							memories: [
								{
									id: "mem_smoke_1",
									organization_id: "org_platform",
									type: "project",
									content: "Use Platform core services for Maestro.",
									repository: request.body?.repository,
									agent: "maestro",
									score: 0.82,
									tags: [
										"source:maestro",
										"maestro-kind:durable-memory",
										"maestro-topic:platform-core",
									],
									created_at: "2026-04-21T00:00:00.000Z",
									updated_at: "2026-04-21T00:00:00.000Z",
								},
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}

				if (parsed.pathname === METER_INGEST_WIDE_EVENT_PATH) {
					return new Response(null, { status: 204 });
				}

				throw new Error(`Unexpected Platform smoke request: ${url}`);
			}),
		);

		await expect(
			resolvePromptTemplate({
				name: "maestro-system",
				label: "production",
				surface: "maestro",
			}),
		).resolves.toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 1,
			versionId: "ver_smoke_1",
			content: "Platform smoke prompt",
		});

		await expect(
			recallRemoteDurableMemories("platform core services", {
				cwd: repoRoot,
				limit: 2,
			}),
		).resolves.toEqual([
			expect.objectContaining({
				score: 0.82,
				entry: expect.objectContaining({
					content: "Use Platform core services for Maestro.",
					topic: "platform-core",
				}),
			}),
		]);

		expect(hasRemoteMeterDestination()).toBe(true);
		await expect(
			mirrorCanonicalTurnEventToMeter(createCanonicalTurnEvent()),
		).resolves.toBe(true);

		const promptRequest = requests.find(
			(request) => request.pathname === PROMPTS_RESOLVE_PATH,
		);
		const memoryRequest = requests.find(
			(request) => request.pathname === MEMORY_RECALL_PATH,
		);
		const meterRequest = requests.find(
			(request) => request.pathname === METER_INGEST_WIDE_EVENT_PATH,
		);

		expect(promptRequest).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				authorization: "Bearer platform-token",
				"connect-protocol-version": "1",
				"content-type": "application/json",
				"x-organization-id": "org_platform",
			}),
			body: {
				name: "maestro-system",
				label: "production",
			},
		});
		expect(memoryRequest).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				authorization: "Bearer platform-token",
				"content-type": "application/json",
				"x-organization-id": "org_platform",
			}),
			body: expect.objectContaining({
				agent: "maestro",
				agent_id: "maestro-smoke",
				limit: 2,
				query: "platform core services",
				review_status: "approved",
				team_id: "team_platform",
				type: "project",
			}),
		});
		expect(memoryRequest?.headers).not.toHaveProperty(
			"connect-protocol-version",
		);
		expect(meterRequest).toMatchObject({
			method: "POST",
			headers: expect.objectContaining({
				authorization: "Bearer platform-token",
				"connect-protocol-version": "1",
				"content-type": "application/json",
				"x-organization-id": "org_platform",
			}),
			body: expect.objectContaining({
				agentId: "maestro-smoke",
				eventType: "canonical-turn",
				surface: "maestro",
				teamId: "team_platform",
			}),
		});
	});
});
