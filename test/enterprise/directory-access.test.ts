import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkDirectoryAccess,
	clearDirectoryRulesCache,
	getDefaultRestrictedDirectories,
	getDefaultSafeDirectories,
} from "../../src/security/directory-access.js";

const { findManyMock } = vi.hoisted(() => ({
	findManyMock: vi.fn(),
}));

vi.mock("../../src/db/client.js", () => ({
	getDb: () => ({
		query: {
			directoryAccessRules: {
				findMany: findManyMock,
			},
		},
	}),
}));

describe("Directory Access Control", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	beforeEach(() => {
		findManyMock.mockReset();
		clearDirectoryRulesCache();
	});

	afterEach(() => {
		clearDirectoryRulesCache();
		if (originalPlatform) {
			Object.defineProperty(process, "platform", originalPlatform);
		}
	});

	function stubPlatform(platform: NodeJS.Platform): void {
		Object.defineProperty(process, "platform", {
			value: platform,
		});
	}

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
			expect(dirs.some((d) => d.includes(".maestro"))).toBe(true);
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

	describe("checkDirectoryAccess", () => {
		const context = {
			userId: "user-1",
			orgId: "org-1",
			roleId: "role-1",
		};

		it("denies bare directory nodes matched by /** rules", async () => {
			findManyMock.mockResolvedValue([
				{
					pattern: "**/.git/**",
					isAllowed: false,
					priority: 50,
					roleIds: null,
					description: "Git metadata",
				},
			]);

			const result = await checkDirectoryAccess(
				context,
				join(tmpdir(), "project", ".git"),
			);

			expect(result).toMatchObject({
				allowed: false,
				matchedRule: "**/.git/**",
				reason: "Path denied by access rule",
			});
		});

		it("matches deny rules case-insensitively on macOS", async () => {
			stubPlatform("darwin");
			findManyMock.mockResolvedValue([
				{
					pattern: "/tmp/secrets/**",
					isAllowed: false,
					priority: 50,
					roleIds: null,
					description: "Secrets",
				},
			]);

			const result = await checkDirectoryAccess(context, "/TMP/SECRETS/key");

			expect(result).toMatchObject({
				allowed: false,
				matchedRule: "/tmp/secrets/**",
				reason: "Path denied by access rule",
			});
		});
	});
});
