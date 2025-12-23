import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	getDefaultRestrictedDirectories,
	getDefaultSafeDirectories,
} from "../../src/security/directory-access.js";

describe("Directory Access Control", () => {
	describe("getDefaultSafeDirectories", () => {
		it("includes tmpdir()", () => {
			const dirs = getDefaultSafeDirectories();
			expect(dirs).toContain(tmpdir());
		});

		it("includes /tmp and /var/tmp on non-Windows", () => {
			const dirs = getDefaultSafeDirectories();
			if (process.platform !== "win32") {
				expect(dirs).toContain("/tmp");
				expect(dirs).toContain("/var/tmp");
			}
		});

		it("includes composer config directory", () => {
			const dirs = getDefaultSafeDirectories();
			expect(dirs.some((d) => d.includes(".composer"))).toBe(true);
		});
	});

	describe("getDefaultRestrictedDirectories", () => {
		it("includes platform system directories", () => {
			const dirs = getDefaultRestrictedDirectories();
			if (process.platform === "win32") {
				expect(dirs.some((dir) => dir.toLowerCase().includes("windows"))).toBe(
					true,
				);
			} else {
				expect(dirs).toContain("/etc");
				expect(dirs).toContain("/sys");
				expect(dirs).toContain("/proc");
			}
		});

		it("includes node_modules pattern", () => {
			const dirs = getDefaultRestrictedDirectories();
			expect(dirs).toContain("**/node_modules/**");
		});

		it("includes .git pattern", () => {
			const dirs = getDefaultRestrictedDirectories();
			expect(dirs).toContain("**/.git/**");
		});
	});
});
