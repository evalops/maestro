import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { managedGatewayAliasDefinitions } from "../testing/evalops-managed.js";

const answers = ["1", "1", "n"];
const questionMock = vi.fn(async () => answers.shift() ?? "");
const closeMock = vi.fn();

vi.mock("node:readline/promises", () => ({
	createInterface: vi.fn(() => ({
		question: questionMock,
		close: closeMock,
	})),
}));

describe("handleConfigInit", () => {
	const originalCwd = process.cwd();
	const originalLog = console.log;
	const originalArgv = [...process.argv];
	const originalGatewayUrl = process.env.MAESTRO_LLM_GATEWAY_URL;
	let tempDir: string;
	let output: string[];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "maestro-config-init-"));
		process.chdir(tempDir);
		output = [];
		console.log = (...args: unknown[]) => {
			output.push(args.map((arg) => String(arg)).join(" "));
		};
		process.argv = ["node", "maestro", "config", "init"];
		Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		answers.splice(0, answers.length, "1", "1", "n");
		questionMock.mockClear();
		closeMock.mockClear();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		console.log = originalLog;
		process.argv = [...originalArgv];
		if (originalGatewayUrl === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_LLM_GATEWAY_URL");
		} else {
			process.env.MAESTRO_LLM_GATEWAY_URL = originalGatewayUrl;
		}
		rmSync(tempDir, { recursive: true, force: true });
		vi.resetModules();
	});

	type ConfigInitProvider = {
		id: string;
		baseUrl: string;
		api: string;
		models: Array<{ id: string }>;
	};

	async function initManagedGatewayPreset(
		preset: string,
	): Promise<ConfigInitProvider> {
		process.argv = ["node", "maestro", "config", "init", "--preset", preset];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: ConfigInitProvider[];
		};
		return config.providers[0]!;
	}

	it("writes maestro-branded env guidance and next steps", async () => {
		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const envExample = readFileSync(join(tempDir, ".env.example"), "utf8");
		expect(envExample).toContain("# Maestro Configuration");
		expect(envExample).not.toContain("# Composer Configuration");

		const combined = output.join("\n");
		expect(combined).toContain("Run: maestro models list");
		expect(combined).toContain('Start using: maestro "your prompt"');
		expect(combined).not.toContain("Run: composer models list");
		expect(combined).not.toContain('Start using: composer "your prompt"');
		expect(closeMock).toHaveBeenCalledTimes(1);
	});

	for (const definition of managedGatewayAliasDefinitions) {
		it(`writes ${definition.id} config with the gateway preset`, async () => {
			const provider = await initManagedGatewayPreset(definition.id);

			expect(provider).toMatchObject({
				id: definition.id,
				baseUrl: "http://gateway.example/v1",
				api: definition.api,
			});
			expect(provider.models[0]?.id).toBe(definition.defaultModel);
			expect(output.join("\n")).toContain(
				"Managed gateway preset does not use a local API key",
			);
		});
	}
});
