import { afterEach, describe, expect, it, vi } from "vitest";

const DEFAULT_MANAGED_GATEWAY_BASE_URL = "http://127.0.0.1:8081/v1";

describe("config provider presets", () => {
	const originalGatewayUrl = process.env.MAESTRO_LLM_GATEWAY_URL;

	afterEach(() => {
		if (originalGatewayUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		} else {
			process.env.MAESTRO_LLM_GATEWAY_URL = originalGatewayUrl;
		}
		vi.resetModules();
	});

	it("projects every managed provider definition into a matching preset", async () => {
		Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		vi.resetModules();

		const [{ PROVIDER_PRESETS }, { EVALOPS_MANAGED_PROVIDER_DEFINITIONS }] =
			await Promise.all([
				import("../../src/cli/commands/config.js"),
				import("../../src/providers/evalops-managed.js"),
			]);

		const managedPresets = PROVIDER_PRESETS.filter((preset) =>
			EVALOPS_MANAGED_PROVIDER_DEFINITIONS.some(
				(definition) => definition.id === preset.id,
			),
		);

		expect(managedPresets.map((preset) => preset.id)).toEqual(
			EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map((definition) => definition.id),
		);

		for (const definition of EVALOPS_MANAGED_PROVIDER_DEFINITIONS) {
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

		const [{ PROVIDER_PRESETS }, { EVALOPS_MANAGED_PROVIDER_DEFINITIONS }] =
			await Promise.all([
				import("../../src/cli/commands/config.js"),
				import("../../src/providers/evalops-managed.js"),
			]);

		const managedPresetIds = new Set(
			EVALOPS_MANAGED_PROVIDER_DEFINITIONS.map((definition) => definition.id),
		);

		for (const preset of PROVIDER_PRESETS.filter((candidate) =>
			managedPresetIds.has(candidate.id),
		)) {
			expect(preset.baseUrl).toBe("http://gateway.example/v1");
		}
	});
});
