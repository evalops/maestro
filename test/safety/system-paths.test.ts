import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	getSystemPaths,
	isSystemPath,
} from "../../src/safety/path-containment.js";

const systemPathsConfig = JSON.parse(
	readFileSync(
		new URL("../../docs/system-paths.json", import.meta.url),
		"utf8",
	),
) as {
	linux: string[];
	macos: string[];
	windows: string[];
};

describe("System paths list", () => {
	it("includes platform-specific entries", () => {
		const paths = getSystemPaths();
		if (process.platform === "darwin") {
			expect(paths).toContain("/System");
			expect(paths).toContain("/Library");
			return;
		}
		if (process.platform === "win32") {
			const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
			expect(paths).toContain(systemRoot);
			expect(isSystemPath(`${systemRoot}\\System32`)).toBe(true);
			return;
		}
		expect(paths).toContain("/proc");
		expect(paths).toContain("/sys");
		expect(paths).toContain("/run");
	});

	it("matches shared system paths config", () => {
		const paths = getSystemPaths().slice().sort();
		const expected =
			process.platform === "darwin"
				? systemPathsConfig.macos
				: process.platform === "win32"
					? [
							process.env.SystemRoot ?? "C:\\Windows",
							process.env.ProgramFiles ?? "C:\\Program Files",
							process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
						]
					: systemPathsConfig.linux;
		expect(paths).toEqual(expected.slice().sort());
	});

	it("normalizes Windows paths in shared config", () => {
		for (const path of systemPathsConfig.windows) {
			expect(path).toMatch(/^[A-Za-z]:\\/);
			expect(path).not.toMatch(/\\\\/);
			expect(path).not.toMatch(/\//);
		}
	});
});
