import { describe, expect, it } from "vitest";
import {
	getSystemPaths,
	isSystemPath,
} from "../../src/safety/path-containment.js";

describe("System paths list", () => {
	it("includes platform-specific entries", () => {
		const paths = getSystemPaths();
		if (process.platform === "darwin") {
			expect(paths).toContain("/System");
			expect(paths).toContain("/Library");
			return;
		}
		if (process.platform === "win32") {
			expect(paths).toContain("C:\\Windows");
			expect(isSystemPath("c:\\windows\\system32")).toBe(true);
			return;
		}
		expect(paths).toContain("/proc");
		expect(paths).toContain("/sys");
		expect(paths).toContain("/run");
	});
});
