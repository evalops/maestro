import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearConfigCache } from "../../src/config/index.js";
import { resolveMaestroSystemPrompt } from "../../src/prompts/system-prompt.js";

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

describe("resolveMaestroSystemPrompt", () => {
	let originalCwd: string;
	let originalHome: string | undefined;
	let testDir: string;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalHome = process.env.MAESTRO_HOME;
		testDir = join(tmpdir(), `maestro-managed-prompt-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.chdir(testDir);

		const maestroHome = join(testDir, "maestro-home");
		mkdirSync(maestroHome, { recursive: true });
		process.env.MAESTRO_HOME = maestroHome;
		clearConfigCache();
		vi.unstubAllGlobals();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (originalHome === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_HOME");
		} else {
			process.env.MAESTRO_HOME = originalHome;
		}
		delete process.env.PROMPTS_SERVICE_URL;
		delete process.env.PROMPTS_SERVICE_TOKEN;
		delete process.env.PROMPTS_SERVICE_ORGANIZATION_ID;
		delete process.env.PROMPTS_SERVICE_TIMEOUT_MS;
		clearConfigCache();
		vi.unstubAllGlobals();
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	it("uses the prompts service when a managed prompt is available", async () => {
		process.env.PROMPTS_SERVICE_URL = "http://prompts.test";
		process.env.PROMPTS_SERVICE_TOKEN = "prompts-token";
		process.env.PROMPTS_SERVICE_ORGANIZATION_ID = "org_123";
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							version: {
								id: "ver_9",
								version: 9,
								content: "Managed system instructions",
							},
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					),
			),
		);

		const result = await resolveMaestroSystemPrompt();

		expect(result.promptMetadata).toEqual({
			name: "maestro-system",
			label: "production",
			surface: "maestro",
			version: 9,
			versionId: "ver_9",
			hash: sha256("Managed system instructions"),
			source: "service",
		});
		expect(result.systemPrompt).toContain("Managed system instructions");
		expect(result.systemPrompt).toContain("Current working directory:");
	});

	it("falls back to the bundled prompt when the service does not resolve", async () => {
		process.env.PROMPTS_SERVICE_URL = "http://prompts.test";
		process.env.PROMPTS_SERVICE_TOKEN = "prompts-token";
		process.env.PROMPTS_SERVICE_ORGANIZATION_ID = "org_123";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not found", { status: 404 })),
		);

		const result = await resolveMaestroSystemPrompt({ toolNames: [] });

		expect(result.promptMetadata.source).toBe("bundled");
		expect(result.promptMetadata.version).toBeUndefined();
		expect(result.systemPrompt).toContain(
			"Length limits: keep text between tool calls to <=25 words. Keep final responses to <=100 words unless the task requires more detail.",
		);
	});

	it("prefers an explicit custom prompt over the managed prompt service", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const result = await resolveMaestroSystemPrompt({
			customPrompt: "Custom override instructions",
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.promptMetadata.source).toBe("override");
		expect(result.promptMetadata.hash).toBe(
			sha256("Custom override instructions"),
		);
		expect(result.systemPrompt).toContain("Custom override instructions");
	});
});
