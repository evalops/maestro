import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginAgentMetadataFromDirectories } from "../../src/agent/plugin-agent-loader.js";

describe("plugin agent metadata loader", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function agent(key: string, entry = "index.js"): string {
		const root = mkdtempSync(join(tmpdir(), "maestro-plugin-agent-"));
		roots.push(root);
		const directory = join(root, key);
		mkdirSync(directory);
		writeFileSync(
			join(directory, "agent.json"),
			JSON.stringify({ key, label: "Focused reviewer", entry }),
		);
		writeFileSync(join(directory, "index.js"), "export default {};");
		return directory;
	}

	it("loads immutable static metadata with resolved entries", () => {
		const directory = agent("focused-reviewer");
		const result = loadPluginAgentMetadataFromDirectories({
			project: [directory],
		});

		expect(result.errors).toEqual([]);
		expect(result.metadata).toEqual([
			expect.objectContaining({
				key: "focused-reviewer",
				label: "Focused reviewer",
				scope: "project",
				entry: realpathSync(join(directory, "index.js")),
			}),
		]);
		expect(Object.isFrozen(result.metadata[0])).toBe(true);
	});

	it("rejects duplicate keys and entries that escape through symlinks", () => {
		const first = agent("reviewer");
		const duplicate = agent("reviewer");
		const escaping = agent("escaping", "outside.js");
		const outside = join(roots.at(-1)!, "outside-target.js");
		writeFileSync(outside, "export default {};");
		symlinkSync(outside, join(escaping, "outside.js"));

		const result = loadPluginAgentMetadataFromDirectories({
			user: [first],
			project: [duplicate, escaping],
		});

		expect(result.metadata).toHaveLength(1);
		expect(result.errors).toEqual([
			expect.stringContaining("Duplicate plugin agent key: reviewer"),
			expect.stringContaining("must remain inside"),
		]);
	});
});
