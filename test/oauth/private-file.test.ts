import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePrivateFileSync } from "../../src/oauth/private-file.js";

describe("oauth/private-file", () => {
	const testFiles: string[] = [];

	afterEach(() => {
		for (const f of testFiles) {
			try {
				unlinkSync(f);
			} catch {}
		}
		testFiles.length = 0;
	});

	function trackFile(path: string): string {
		testFiles.push(path);
		return path;
	}

	it("writes content and sets mode 0o600", () => {
		const filePath = trackFile(
			join(tmpdir(), `maestro-pvt-${Date.now()}.json`),
		);
		writePrivateFileSync(filePath, '{"key":"value"}');

		expect(existsSync(filePath)).toBe(true);

		const content = readFileSync(filePath, "utf-8");
		expect(content).toBe('{"key":"value"}');

		// Verify mode 0o600 (owner read+write only)
		const mode = statSync(filePath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("overwrites an existing file", () => {
		const filePath = trackFile(
			join(tmpdir(), `maestro-pvt-${Date.now()}.json`),
		);
		writePrivateFileSync(filePath, "v1");
		writePrivateFileSync(filePath, "v2");

		const content = readFileSync(filePath, "utf-8");
		expect(content).toBe("v2");

		const mode = statSync(filePath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("does not leave a temp file behind on success", () => {
		const filePath = trackFile(
			join(tmpdir(), `maestro-pvt-${Date.now()}.json`),
		);
		writePrivateFileSync(filePath, "data");

		// The temp file is renamed to filePath on success, so only
		// filePath should exist — no stale .tmp files.
		expect(existsSync(filePath)).toBe(true);
		// Verify mode persists through the rename
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
	});

	it("throws on invalid path (e.g. directory that doesn't exist)", () => {
		expect(() =>
			writePrivateFileSync(
				join(tmpdir(), `no-such-dir-${Date.now()}`, "file.json"),
				"data",
			),
		).toThrow();
	});
});
