import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkPolicy } from "../../src/safety/policy.js";

vi.mock("node:fs");
vi.mock("node:os", () => ({
	homedir: () => "/mock-home",
}));

describe("checkPolicy dependency extraction", () => {
	const POLICY_PATH = join("/mock-home", ".composer", "policy.json");

	beforeEach(() => {
		vi.resetAllMocks();
		// (os.homedir as any).mockReturnValue("/mock-home"); // Removed as it's handled by factory
		// Clear the cache first by simulating non-existent file
		(fs.existsSync as any).mockImplementation((path: string) => false);
		// Call checkPolicy to clear cache
		checkPolicy({ toolName: "bash", args: {} } as any);
	});

	it("catches uppercase npm install commands (case-insensitive check)", () => {
		// Setup policy
		const policy = {
			dependencies: {
				blocked: ["evil-pkg"],
			},
		};

		// Enable file existence and content
		(fs.existsSync as any).mockImplementation(
			(path: string) => path === POLICY_PATH,
		);
		(fs.readFileSync as any).mockImplementation((path: string) => {
			if (path === POLICY_PATH) return JSON.stringify(policy);
			return "";
		});
		(fs.watch as any).mockReturnValue({ unref: () => {}, close: () => {} });

		// Test with uppercase command
		const context = {
			toolName: "bash",
			args: {
				command: "NPM install evil-pkg",
			},
		};

		const result = checkPolicy(context as any);

		expect(result.allowed).toBe(false);
		expect(result.reason).toMatch(/explicitly blocked/);
	});
});
