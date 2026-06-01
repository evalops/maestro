import { writeFileSync } from "node:fs";
import {
	type IncomingMessage,
	type ServerResponse,
	createServer,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH,
	MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG,
	MAESTRO_EVALOPS_MANAGED_KILL_SWITCH,
	MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
	MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH,
	MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
	areAutonomousActionsDisabled,
	assignExperiment,
	evaluateFeatureFlag,
	isDraftAndConfirmDefaultEnabled,
	isFeatureFlagEnabled,
	isPlatformRuntimeBridgeDisabled,
	isPlatformRuntimeObserveEnabled,
	isPlatformToolExecutionBridgeEnabled,
	resetFeatureFlagCacheForTests,
} from "../../src/config/feature-flags.js";

describe("feature flags", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_URL");
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_BEARER_TOKEN");
		Reflect.deleteProperty(process.env, "EVALOPS_FLAG_CONTROL_URL");
		Reflect.deleteProperty(process.env, "EVALOPS_FLAG_CONTROL_BEARER_TOKEN");
		Reflect.deleteProperty(process.env, "KUBERNETES_SERVICE_HOST");
		resetFeatureFlagCacheForTests();
	});

	it("returns false when no feature flag file is configured", () => {
		expect(isFeatureFlagEnabled(MAESTRO_EVALOPS_MANAGED_KILL_SWITCH)).toBe(
			false,
		);
	});

	it("reads the configured snapshot", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_EVALOPS_MANAGED_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isFeatureFlagEnabled(MAESTRO_EVALOPS_MANAGED_KILL_SWITCH)).toBe(
			true,
		);
	});

	it("detects the autonomous actions kill switch", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_AUTONOMOUS_ACTIONS_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(areAutonomousActionsDisabled()).toBe(true);
	});

	it("detects the draft-and-confirm default flag", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_DRAFT_AND_CONFIRM_DEFAULT_FLAG,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isDraftAndConfirmDefaultEnabled()).toBe(true);
	});

	it("detects the platform runtime observe and tool execution bridge flags", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_PLATFORM_RUNTIME_AGENT_RUNTIME_OBSERVE_FLAG,
						enabled: true,
					},
					{
						key: MAESTRO_PLATFORM_RUNTIME_TOOL_EXECUTION_BRIDGE_FLAG,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isPlatformRuntimeObserveEnabled()).toBe(true);
		expect(isPlatformToolExecutionBridgeEnabled()).toBe(true);
	});

	it("detects the platform runtime bridge kill switch", () => {
		const path = join(
			tmpdir(),
			`maestro-feature-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: MAESTRO_PLATFORM_RUNTIME_BRIDGE_KILL_SWITCH,
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;

		expect(isPlatformRuntimeBridgeDisabled()).toBe(true);
	});

	it("evaluates a remote flag through the OFREP-compatible endpoint", async () => {
		const server = await startJSONServer(async (request, response) => {
			expect(request.method).toBe("POST");
			expect(request.url).toBe(
				"/ofrep/v1/evaluate/flags/maestro.platform_runtime.agent_runtime_observe",
			);
			expect(request.headers.authorization).toBe("Bearer test-token");
			const payload = await readJSON(request);
			expect(payload).toMatchObject({
				context: {
					cohort_enabled: true,
					rollout_bucket: 17,
					subject: "workspace-1",
					surface: "maestro",
					targetingKey: "workspace-1",
				},
			});

			writeJSON(response, {
				key: "maestro.platform_runtime.agent_runtime_observe",
				metadata: {
					flag_found: true,
					flag_reason: "included",
					flag_subject: "workspace-1",
					rollout_bucket: 17,
				},
				reason: "SPLIT",
				value: true,
				variant: "true",
			});
		});
		try {
			process.env.EVALOPS_FEATURE_FLAGS_URL = server.url;
			process.env.EVALOPS_FEATURE_FLAGS_BEARER_TOKEN = "test-token";

			await expect(
				evaluateFeatureFlag(
					"maestro.platform_runtime.agent_runtime_observe",
					{
						attributes: {
							cohort_enabled: true,
							rollout_bucket: 17,
							surface: "maestro",
						},
						subject: "workspace-1",
					},
					false,
				),
			).resolves.toMatchObject({
				key: "maestro.platform_runtime.agent_runtime_observe",
				reason: "included",
				value: true,
				variant: "true",
			});
		} finally {
			await server.close();
		}
	});

	it("falls back when remote flag values are not boolean", async () => {
		const server = await startJSONServer(async (_request, response) => {
			writeJSON(response, {
				key: "maestro.platform_runtime.agent_runtime_observe",
				value: "true",
				variant: "enabled",
			});
		});
		try {
			await expect(
				evaluateFeatureFlag(
					"maestro.platform_runtime.agent_runtime_observe",
					{ subject: "workspace-1" },
					false,
					{ baseUrl: server.url },
				),
			).resolves.toMatchObject({
				reason: "invalid_remote_value",
				value: false,
				variant: "false",
			});
		} finally {
			await server.close();
		}
	});

	it("ignores non-object remote flag metadata", async () => {
		const server = await startJSONServer(async (_request, response) => {
			writeJSON(response, {
				key: "maestro.platform_runtime.agent_runtime_observe",
				metadata: ["flag_reason", "included"],
				reason: "REMOTE_DEFAULT",
				value: true,
				variant: "true",
			});
		});
		try {
			await expect(
				evaluateFeatureFlag(
					"maestro.platform_runtime.agent_runtime_observe",
					{ subject: "workspace-1" },
					false,
					{ baseUrl: server.url },
				),
			).resolves.toMatchObject({
				metadata: {},
				reason: "REMOTE_DEFAULT",
				value: true,
				variant: "true",
			});
		} finally {
			await server.close();
		}
	});

	it("treats empty remote base URL overrides as unset", async () => {
		const server = await startJSONServer(async (_request, response) => {
			writeJSON(response, {
				key: "maestro.platform_runtime.agent_runtime_observe",
				value: true,
			});
		});
		try {
			process.env.EVALOPS_FEATURE_FLAGS_URL = server.url;

			await expect(
				evaluateFeatureFlag(
					"maestro.platform_runtime.agent_runtime_observe",
					{ subject: "workspace-1" },
					false,
					{ baseUrl: "  /  " },
				),
			).resolves.toMatchObject({
				value: true,
				variant: "true",
			});
		} finally {
			await server.close();
		}
	});

	for (const timeoutMs of [0, -1]) {
		it(`treats timeoutMs=${timeoutMs} as disabling the remote timeout`, async () => {
			const server = await startJSONServer(async (_request, response) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				writeJSON(response, {
					key: "maestro.platform_runtime.agent_runtime_observe",
					metadata: { flag_reason: "included" },
					value: true,
					variant: "true",
				});
			});
			try {
				await expect(
					evaluateFeatureFlag(
						"maestro.platform_runtime.agent_runtime_observe",
						{ subject: "workspace-1" },
						false,
						{ baseUrl: server.url, timeoutMs },
					),
				).resolves.toMatchObject({
					key: "maestro.platform_runtime.agent_runtime_observe",
					reason: "included",
					value: true,
					variant: "true",
				});
			} finally {
				await server.close();
			}
		});
	}

	it("assigns a remote experiment and records caller metadata", async () => {
		const server = await startJSONServer(async (request, response) => {
			expect(request.method).toBe("POST");
			expect(request.url).toBe(
				"/api/experiments/maestro.router_quality_ab/assign",
			);
			const payload = await readJSON(request);
			expect(payload).toMatchObject({
				context: {
					plan_tier: "enterprise",
					subject: "workspace-1",
					targetingKey: "workspace-1",
				},
				metadata: {
					surface: "maestro",
				},
				record_exposure: false,
				subject: "workspace-1",
			});

			writeJSON(response, {
				assigned: true,
				bucket: 42,
				experiment_id: "maestro.router_quality_ab",
				exposure_recorded: false,
				flag_key: "maestro.model_router.candidate",
				in_holdout: false,
				layer_id: "maestro-routing",
				metadata: { surface: "maestro" },
				namespace_end: 100,
				namespace_start: 0,
				reason: "assigned",
				subject: "workspace-1",
				variant: "candidate",
				variant_bucket: 73,
			});
		});
		try {
			await expect(
				assignExperiment(
					"maestro.router_quality_ab",
					{
						attributes: {
							plan_tier: "enterprise",
							subject: "spoofed-workspace",
							targetingKey: "spoofed-workspace",
						},
						subject: "workspace-1",
					},
					{
						baseUrl: server.url,
						metadata: { surface: "maestro" },
						recordExposure: false,
					},
				),
			).resolves.toMatchObject({
				assigned: true,
				experimentId: "maestro.router_quality_ab",
				exposureRecorded: false,
				flagKey: "maestro.model_router.candidate",
				layerId: "maestro-routing",
				reason: "assigned",
				variant: "candidate",
				variantBucket: 73,
			});
		} finally {
			await server.close();
		}
	});

	it("rejects blank experiment assignment subjects before remote calls", async () => {
		await expect(
			assignExperiment(
				"maestro.router_quality_ab",
				{ subject: "   " },
				{ baseUrl: "https://flags.internal.evalops.dev" },
			),
		).resolves.toMatchObject({
			assigned: false,
			reason: "missing_subject",
			subject: "",
		});
	});
});

async function startJSONServer(
	handler: (
		request: IncomingMessage,
		response: ServerResponse,
	) => Promise<void>,
): Promise<{ close: () => Promise<void>; url: string }> {
	const server = createServer((request, response) => {
		handler(request, response).catch((error: unknown) => {
			response.statusCode = 500;
			response.end(error instanceof Error ? error.message : String(error));
		});
	});
	await new Promise<void>((resolve) => {
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address == null || typeof address === "string") {
		throw new Error("test server did not bind a TCP address");
	}
	return {
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
		url: `http://127.0.0.1:${address.port}`,
	};
}

async function readJSON(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJSON(response: ServerResponse, payload: unknown): void {
	response.setHeader("content-type", "application/json");
	response.end(JSON.stringify(payload));
}
