import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getFrameworkSummary,
	getWorkspaceFramework,
	listFrameworks,
	resolveFrameworkPreference,
	setDefaultFramework,
	setWorkspaceFramework,
} from "../../src/config/framework.js";

describe("framework preference resolution", () => {
	let cwd: string;
	let tempDir: string;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		cwd = process.cwd();
		tempDir = mkdtempSync(join(tmpdir(), "composer-framework-"));
		process.chdir(tempDir);
		originalEnv = { ...process.env };
		process.env.COMPOSER_DEFAULT_FRAMEWORK_FILE = join(
			tempDir,
			"default-framework.json",
		);
		process.env.COMPOSER_FRAMEWORK_POLICY_FILE = join(tempDir, "policy.json");
	});

	afterEach(() => {
		process.env = originalEnv;
		process.chdir(cwd);
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
	});

	const writePolicy = (value: unknown) => {
		const policyPath = process.env.COMPOSER_FRAMEWORK_POLICY_FILE;
		if (!policyPath) {
			throw new Error("COMPOSER_FRAMEWORK_POLICY_FILE is not set");
		}
		writeFileSync(policyPath, JSON.stringify(value, null, 2));
	};

	it("prefers locked policy and ignores overrides", () => {
		writePolicy({ framework: { default: "fastapi", locked: true } });
		process.env.COMPOSER_FRAMEWORK_OVERRIDE = "express";

		const pref = resolveFrameworkPreference();
		expect(pref).toEqual({
			id: "fastapi",
			source: "policy (locked)",
			locked: true,
		});
	});

	it("blocks writes when policy is locked even without default", () => {
		writePolicy({ framework: { locked: true } });
		expect(() => setDefaultFramework("fastapi")).toThrow(
			/Framework preference is locked by policy/,
		);
	});

	it("uses env override ahead of env default and workspace", () => {
		process.env.COMPOSER_FRAMEWORK_OVERRIDE = "express";
		process.env.COMPOSER_DEFAULT_FRAMEWORK = "fastapi";
		setWorkspaceFramework("node");

		const pref = resolveFrameworkPreference();
		expect(pref).toEqual({
			id: "express",
			source: "env override",
			locked: false,
		});
	});

	it("prefers workspace file over user default when no env", () => {
		setWorkspaceFramework("fastapi");
		setDefaultFramework("express");
		const pref = resolveFrameworkPreference();
		expect(pref).toEqual({
			id: "fastapi",
			source: ".composer/workspace.json",
			locked: false,
		});
		expect(getWorkspaceFramework()).toBe("fastapi");
	});

	it("rejects unknown frameworks on write", () => {
		expect(() => setDefaultFramework("unknown-stack")).toThrow(
			/Unknown framework/,
		);
	});

	it("lists known frameworks for UI help", () => {
		const ids = listFrameworks().map((f) => f.id);
		expect(ids).toContain("fastapi");
		expect(ids).toContain("express");
	});

	it("throws when attempting to summarize unknown framework ids", () => {
		expect(() => getFrameworkSummary("unknown")).toThrow(/Unknown framework/);
	});
});
