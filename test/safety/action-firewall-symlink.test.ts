import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultActionFirewall } from "../../src/safety/action-firewall.js";

const isWindows = process.platform === "win32";
const describeIfSupported = isWindows ? describe.skip : describe;

describeIfSupported("ActionFirewall - Symlink Containment", () => {
	const originalCwd = process.cwd;
	let workspaceRoot = "";
	let linkPath = "";

	beforeAll(() => {
		workspaceRoot = mkdtempSync(join(tmpdir(), "composer-symlink-test-"));
		linkPath = join(workspaceRoot, "system-link");
		symlinkSync("/etc", linkPath, "dir");
		process.cwd = () => workspaceRoot;
	});

	afterAll(() => {
		process.cwd = originalCwd;
		try {
			rmSync(workspaceRoot, { recursive: true, force: true });
		} catch {
			// ignore cleanup failures
		}
	});

	it("blocks writes through symlinks into system paths", async () => {
		const verdict = await defaultActionFirewall.evaluate({
			toolName: "write",
			args: { path: join(linkPath, "passwd") },
		});
		expect(verdict.action).toBe("block");
		expect(verdict).toMatchObject({ ruleId: "system-path-protection" });
	});
});
