import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFeatureFlagCacheForTests } from "../../src/config/feature-flags.js";

const DEFAULT_MANAGED_GATEWAY_BASE_URL = "http://127.0.0.1:8081/v1";

describe("config provider presets", () => {
	const originalGatewayUrl = process.env.MAESTRO_LLM_GATEWAY_URL;

	afterEach(() => {
		if (originalGatewayUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		} else {
			process.env.MAESTRO_LLM_GATEWAY_URL = originalGatewayUrl;
		}
		Reflect.deleteProperty(process.env, "EVALOPS_FEATURE_FLAGS_PATH");
		resetFeatureFlagCacheForTests();
		vi.resetModules();
	});

	it("projects every managed provider definition into a matching preset", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		vi.resetModules();

		const [
			{ getProviderPresets },
			{ ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS },
		] = await Promise.all([
			import("../../src/cli/commands/config.js"),
			import("../../src/providers/evalops-managed.js"),
		]);
		const providerPresets = getProviderPresets();

		const managedPresets = providerPresets.filter((preset) =>
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.some(
				(definition) => definition.id === preset.id,
			),
		);

		expect(managedPresets.map((preset) => preset.id)).toEqual(
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
				(definition) => definition.id,
			),
		);

		for (const definition of ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS) {
			expect(
				managedPresets.find((preset) => preset.id === definition.id),
			).toMatchObject({
				id: definition.id,
				name: definition.name,
				api: definition.api,
				defaultModel: definition.defaultModel,
				baseUrl: DEFAULT_MANAGED_GATEWAY_BASE_URL,
				requiresApiKey: false,
				note: definition.note,
			});
		}
	});

	it("applies MAESTRO_LLM_GATEWAY_URL to every managed provider preset", async () => {
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		vi.resetModules();

		const [
			{ getProviderPresets },
			{ ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS },
		] = await Promise.all([
			import("../../src/cli/commands/config.js"),
			import("../../src/providers/evalops-managed.js"),
		]);
		const providerPresets = getProviderPresets();

		const managedPresetIds = new Set(
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
				(definition) => definition.id,
			),
		);

		for (const preset of providerPresets.filter((candidate) =>
			managedPresetIds.has(candidate.id),
		)) {
			expect(preset.baseUrl).toBe("http://gateway.example/v1");
		}
	});

	it("omits managed gateway presets when the kill switch is enabled", async () => {
		const path = join(
			tmpdir(),
			`maestro-config-flags-${Date.now()}-${Math.random()}.json`,
		);
		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: "platform.kill_switches.maestro.evalops_managed",
						enabled: true,
					},
				],
			}),
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
		resetFeatureFlagCacheForTests();
		vi.resetModules();

		const [
			{ getProviderPresets },
			{ ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS },
		] = await Promise.all([
			import("../../src/cli/commands/config.js"),
			import("../../src/providers/evalops-managed.js"),
		]);
		const providerPresets = getProviderPresets();

		const managedPresetIds = new Set(
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
				(definition) => definition.id,
			),
		);

		expect(
			providerPresets.filter((preset) => managedPresetIds.has(preset.id)),
		).toHaveLength(0);
	});

	it("recomputes managed presets when the kill switch flips after import", async () => {
		const path = join(
			tmpdir(),
			`maestro-config-flags-live-${Date.now()}-${Math.random()}.json`,
		);
		process.env.EVALOPS_FEATURE_FLAGS_PATH = path;
		writeFileSync(path, JSON.stringify({ flags: [] }));
		resetFeatureFlagCacheForTests();
		vi.resetModules();

		const [
			{ getProviderPresets },
			{ ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS },
		] = await Promise.all([
			import("../../src/cli/commands/config.js"),
			import("../../src/providers/evalops-managed.js"),
		]);

		const managedPresetIds = new Set(
			ALL_EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map(
				(definition) => definition.id,
			),
		);

		expect(
			getProviderPresets().filter((preset) => managedPresetIds.has(preset.id)),
		).not.toHaveLength(0);

		writeFileSync(
			path,
			JSON.stringify({
				flags: [
					{
						key: "platform.kill_switches.maestro.evalops_managed",
						enabled: true,
					},
				],
			}),
		);
		resetFeatureFlagCacheForTests();

		expect(
			getProviderPresets().filter((preset) => managedPresetIds.has(preset.id)),
		).toHaveLength(0);
	});
});
