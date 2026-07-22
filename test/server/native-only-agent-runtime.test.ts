import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const PRODUCT_RUNTIME_FILES = [
	"src/web-server.ts",
	"src/main.ts",
	"src/server/app-context.ts",
	"src/server/handlers/chat.ts",
	"src/server/handlers/chat-ws.ts",
	"src/server/headless-runtime-service.ts",
	"src/server/automations/scheduler.ts",
	"src/server/prompt-suggestion.ts",
];

describe("native-only product agent runtime", () => {
	it("contains no TypeScript agent escape flags or factories", async () => {
		const sources = await Promise.all(
			PRODUCT_RUNTIME_FILES.map((path) => readFile(path, "utf8")),
		);
		const productRuntime = sources.join("\n");

		expect(productRuntime).not.toContain("MAESTRO_TS_AGENT");
		expect(productRuntime).not.toContain("MAESTRO_ALLOW_TS_AGENT");
		expect(productRuntime).not.toContain("isTsAgentForced");
		expect(productRuntime).not.toMatch(/\bcreateBackgroundAgent\b/);
		expect(productRuntime).not.toMatch(/\bcreateAgent\b/);
	});

	it("does not ship the former TypeScript chat handler", async () => {
		await expect(
			readFile("src/server/handlers/chat-ts-agent.ts", "utf8"),
		).rejects.toMatchObject({ code: "ENOENT" });
	});
});
