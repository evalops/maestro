import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	handleContextCommand,
	renderContextManifestSummary,
} from "../../src/cli/commands/context.js";
import { loadPromptProjectDocManifest } from "../../src/config/index.js";

describe("context command", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "maestro-context-command-"));
		tempDirs.push(dir);
		return dir;
	}

	it("renders a prompt context manifest summary", () => {
		const root = makeTempDir();
		const app = join(root, "apps", "web");
		mkdirSync(app, { recursive: true });
		writeFileSync(join(root, "AGENTS.md"), "root rules");
		writeFileSync(join(app, "AGENTS.md"), "app rules");

		const summary = renderContextManifestSummary(
			loadPromptProjectDocManifest(app),
		);

		expect(summary).toContain(`Prompt context for ${resolve(app)}`);
		expect(summary).toContain("Loaded files:");
		expect(summary).toContain("AGENTS.md");
		expect(summary).toContain("sha256:");
		expect(summary).toContain("multiple_instruction_layers");
	});

	it("prints json for context explain --json", async () => {
		const root = makeTempDir();
		writeFileSync(join(root, "AGENTS.md"), "root rules");
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

		await handleContextCommand("explain", [root, "--json"]);

		const payload = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(payload.cwd).toBe(resolve(root));
		expect(payload.entries[0]).toMatchObject({
			path: resolve(join(root, "AGENTS.md")),
			sourceKind: "project",
			candidateName: "AGENTS.md",
			precedenceIndex: 0,
		});
	});
});
