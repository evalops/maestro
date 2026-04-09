import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	it("writes managed openrouter config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-openrouter",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-openrouter",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("openai/o4-mini");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed anthropic config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-anthropic",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-anthropic",
			baseUrl: "http://gateway.example/v1",
			api: "anthropic-messages",
		});
		expect(provider?.models[0]?.id).toBe("claude-sonnet-4-5");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed azure openai config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-azure-openai",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-azure-openai",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("gpt-4o");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed google config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-google",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-google",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("gemini-2.5-pro");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed groq config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-groq",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-groq",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("llama-3.3-70b-versatile");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed databricks config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-databricks",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-databricks",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe(
			"databricks-meta-llama-3-3-70b-instruct",
		);
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed mistral config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-mistral",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-mistral",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("mistral-large-latest");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});

	it("writes managed xai config with the gateway preset", async () => {
		process.argv = [
			"node",
			"maestro",
			"config",
			"init",
			"--preset",
			"evalops-xai",
		];
		process.env.MAESTRO_LLM_GATEWAY_URL = "http://gateway.example/v1";
		answers.splice(0, answers.length, "n");

		const { handleConfigInit } = await import(
			"../../src/cli/commands/config.js"
		);
		await handleConfigInit();

		const config = JSON.parse(
			readFileSync(join(tempDir, ".maestro", "config.json"), "utf8"),
		) as {
			providers: Array<{
				id: string;
				baseUrl: string;
				api: string;
				models: Array<{ id: string }>;
			}>;
		};
		const provider = config.providers[0];
		expect(provider).toMatchObject({
			id: "evalops-xai",
			baseUrl: "http://gateway.example/v1",
			api: "openai-completions",
		});
		expect(provider?.models[0]?.id).toBe("grok-4-fast");
		expect(output.join("\n")).toContain(
			"Managed gateway preset does not use a local API key",
		);
	});
});
