import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	checkCliRuntimeConformance,
	loadCliRuntimeConformanceFixture,
} from "../../scripts/check-cli-runtime-conformance.ts";

describe("CLI runtime conformance", () => {
	let tempDir = "";

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("passes against the checked-in fixture", () => {
		expect(
			checkCliRuntimeConformance({
				fixture: loadCliRuntimeConformanceFixture(),
			}),
		).toEqual([]);
	});

	it("reports parser drift with case and field context", () => {
		const fixture = loadCliRuntimeConformanceFixture();
		const parserCases = fixture.parserCases as Array<{
			name: string;
			expect: Record<string, unknown>;
		}>;
		parserCases[0] = {
			...parserCases[0],
			expect: {
				...parserCases[0]?.expect,
				mode: "text",
			},
		};

		expect(checkCliRuntimeConformance({ fixture })).toContain(
			'json mode keeps prompt messages expected mode="text" but got "json"',
		);
	});

	it("reports missing runtime anchors with surface context", () => {
		tempDir = join(
			tmpdir(),
			`maestro-cli-runtime-conformance-${process.pid}-${Date.now()}`,
		);
		mkdirSync(join(tempDir, "src/cli"), { recursive: true });
		writeFileSync(join(tempDir, "src/cli/help.ts"), "--mode <mode>\n");

		const failures = checkCliRuntimeConformance({
			rootDir: tempDir,
			fixture: {
				version: 1,
				parserCases: [
					{
						name: "minimal",
						argv: ["hello"],
						expect: { messages: ["hello"] },
					},
				],
				runtimeSurfaces: [
					{
						area: "cli-help",
						path: "src/cli/help.ts",
						anchors: ["--mode <mode>", "--no-session"],
					},
				],
			},
		});

		expect(failures).toContain(
			'cli-help: src/cli/help.ts is missing anchor "--no-session"',
		);
		expect(failures).toContain(
			"fixture is missing runtime surface cli-mode-selection",
		);
	});
});
