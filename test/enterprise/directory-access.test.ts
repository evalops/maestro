import { describe, expect, it } from "vitest";
import {
	getDefaultRestrictedDirectories,
	getDefaultSafeDirectories,
} from "../../src/security/directory-access.js";

describe("Directory Access Control", () => {
	describe("getDefaultSafeDirectories", () => {
		it("includes /tmp", () => {
			const dirs = getDefaultSafeDirectories();
			expect(dirs).toContain("/tmp");
		});

		it("includes /var/tmp", () => {
			const dirs = getDefaultSafeDirectories();
			expect(dirs).toContain("/var/tmp");
		});

		it("includes composer config directory", () => {
			const dirs = getDefaultSafeDirectories();
			expect(dirs.some((d) => d.includes(".composer"))).toBe(true);
		});
	});

	describe("getDefaultRestrictedDirectories", () => {
		it("includes /etc", () => {
			const dirs = getDefaultRestrictedDirectories();
			expect(dirs).toContain("/etc");
		});

		it("includes /sys", () => {
			const dirs = getDefaultRestrictedDirectories();
			expect(dirs).toContain("/sys");
		});

		it("includes /proc", () => {
			const dirs = getDefaultRestrictedDirectories();
			expect(dirs).toContain("/proc");
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
