import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addMemory, upsertScopedMemory } from "../../src/memory/index.js";
import { buildRelevantMemoryPromptAddition } from "../../src/memory/relevant-recall.js";

describe("relevant memory recall", () => {
	let tempRoot: string;
	let originalMaestroHome: string | undefined;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "maestro-memory-recall-"));
		originalMaestroHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = join(tempRoot, ".maestro-home");
	});

	afterEach(() => {
		if (originalMaestroHome === undefined) {
			delete process.env.MAESTRO_HOME;
		} else {
			process.env.MAESTRO_HOME = originalMaestroHome;
		}
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("returns relevant durable memories for multi-word prompts", () => {
		addMemory("api-design", "Use cursor pagination for REST list endpoints.", {
			tags: ["rest", "pagination"],
		});
		addMemory("frontend", "Prefer CSS variables for theming.", {
			tags: ["css"],
		});

		const addition = buildRelevantMemoryPromptAddition(
			"Update the REST list endpoints to use cursor pagination",
		);

		expect(addition).toContain("Automatic memory recall:");
		expect(addition).toContain("api-design");
		expect(addition).toContain("cursor pagination");
		expect(addition).not.toContain("CSS variables");
	});

	it("prioritizes current-session session memory and excludes other sessions", () => {
		upsertScopedMemory(
			"session-memory",
			"# Session Memory\nKeep the retry backoff logic intact.",
			{ sessionId: "sess-current" },
		);
		upsertScopedMemory(
			"session-memory",
			"# Session Memory\nOld unrelated migration note.",
			{ sessionId: "sess-other" },
		);

		const addition = buildRelevantMemoryPromptAddition(
			"Preserve the retry backoff logic in this change",
			{ sessionId: "sess-current" },
		);

		expect(addition).toContain("current session");
		expect(addition).toContain("retry backoff logic");
		expect(addition).not.toContain("Old unrelated migration note");
	});

	it("skips recall for low-context prompts", () => {
		addMemory("api-design", "Use cursor pagination for REST list endpoints.");

		expect(buildRelevantMemoryPromptAddition("pagination")).toBeNull();
	});
});
