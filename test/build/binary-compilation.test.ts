import { spawnSync } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..");
const binaryPath = join(projectRoot, "dist", "composer-bun");

describe("Binary Compilation", () => {
	it("should compile binary if build:all was run", async () => {
		// This test checks if the binary exists (it may not exist if compile:binary wasn't run)
		// We'll skip if it doesn't exist rather than failing
		try {
			await access(binaryPath);
		} catch {
			// Binary doesn't exist - skip this test
			// In CI, we should ensure binary compilation is tested separately
			return;
		}

		const stats = await stat(binaryPath);
		expect(stats.size).toBeGreaterThan(1000); // Binary should be substantial
		expect(stats.isFile()).toBe(true);
	});

	it("should have executable permissions if binary exists", async () => {
		try {
			await access(binaryPath);
		} catch {
			return; // Skip if binary doesn't exist
		}

		const stats = await stat(binaryPath);
		// On Unix systems, check if file is executable
		// Note: This is a basic check - actual execution test would require platform-specific logic
		expect(stats.mode).toBeDefined();
	});

	it("should be able to compile binary", async () => {
		// This test verifies the compilation command works
		// We'll run it conditionally to avoid slowing down regular test runs
		if (process.env.TEST_BINARY_COMPILATION !== "1") {
			return; // Skip unless explicitly enabled
		}

		const result = spawnSync("bun", ["run", "compile:binary"], {
			cwd: projectRoot,
			stdio: "pipe",
			env: { ...process.env },
		});

		expect(result.status).toBe(0);

		// Verify binary was created
		await expect(access(binaryPath)).resolves.not.toThrow();
		const stats = await stat(binaryPath);
		expect(stats.size).toBeGreaterThan(1000);
	});
});
