import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureDir, ensureDirSync } from "../src/utils/fs.js";

describe("ensureDirSync", () => {
	const testDir = join(process.cwd(), "test-tmp-sync");

	beforeEach(() => {
		// Clean up before each test
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	afterEach(() => {
		// Clean up after each test
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("creates directory if it does not exist", () => {
		expect(existsSync(testDir)).toBe(false);

		const created = ensureDirSync(testDir);

		expect(created).toBe(true);
		expect(existsSync(testDir)).toBe(true);
	});

	it("returns false if directory already exists", () => {
		mkdirSync(testDir);
		expect(existsSync(testDir)).toBe(true);

		const created = ensureDirSync(testDir);

		expect(created).toBe(false);
		expect(existsSync(testDir)).toBe(true);
	});

	it("creates nested directories recursively", () => {
		const nestedDir = join(testDir, "a", "b", "c");
		expect(existsSync(nestedDir)).toBe(false);

		const created = ensureDirSync(nestedDir);

		expect(created).toBe(true);
		expect(existsSync(nestedDir)).toBe(true);
	});

	it("handles existing nested directories", () => {
		const nestedDir = join(testDir, "existing", "nested");
		mkdirSync(nestedDir, { recursive: true });
		expect(existsSync(nestedDir)).toBe(true);

		const created = ensureDirSync(nestedDir);

		expect(created).toBe(false);
		expect(existsSync(nestedDir)).toBe(true);
	});
});

describe("ensureDir", () => {
	const testDir = join(process.cwd(), "test-tmp-async");

	beforeEach(async () => {
		// Clean up before each test
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true });
		}
	});

	afterEach(async () => {
		// Clean up after each test
		if (existsSync(testDir)) {
			await rm(testDir, { recursive: true });
		}
	});

	it("creates directory if it does not exist", async () => {
		expect(existsSync(testDir)).toBe(false);

		const created = await ensureDir(testDir);

		expect(created).toBe(true);
		expect(existsSync(testDir)).toBe(true);
	});

	it("returns false if directory already exists", async () => {
		await mkdir(testDir);
		expect(existsSync(testDir)).toBe(true);

		const created = await ensureDir(testDir);

		expect(created).toBe(false);
		expect(existsSync(testDir)).toBe(true);
	});

	it("creates nested directories recursively", async () => {
		const nestedDir = join(testDir, "x", "y", "z");
		expect(existsSync(nestedDir)).toBe(false);

		const created = await ensureDir(nestedDir);

		expect(created).toBe(true);
		expect(existsSync(nestedDir)).toBe(true);
	});

	it("handles existing nested directories", async () => {
		const nestedDir = join(testDir, "deep", "path");
		await mkdir(nestedDir, { recursive: true });
		expect(existsSync(nestedDir)).toBe(true);

		const created = await ensureDir(nestedDir);

		expect(created).toBe(false);
		expect(existsSync(nestedDir)).toBe(true);
	});
});
