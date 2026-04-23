import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	PathValidationError,
	expandUserPath,
	isWithinCwd,
	validatePath,
} from "../../src/utils/path-validation.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

afterEach(() => {
	if (ORIGINAL_HOME === undefined) {
		Reflect.deleteProperty(process.env, "HOME");
	} else {
		process.env.HOME = ORIGINAL_HOME;
	}
	if (ORIGINAL_USERPROFILE === undefined) {
		Reflect.deleteProperty(process.env, "USERPROFILE");
	} else {
		process.env.USERPROFILE = ORIGINAL_USERPROFILE;
	}

	vi.restoreAllMocks();
});

describe("expandUserPath", () => {
	it("prefers HOME when set", () => {
		process.env.HOME = "/tmp/home-env";
		Reflect.deleteProperty(process.env, "USERPROFILE");
		const spy = vi.spyOn(os, "homedir").mockReturnValue("/ignored");

		expect(expandUserPath("~")).toBe("/tmp/home-env");
		expect(expandUserPath("~/docs")).toBe("/tmp/home-env/docs");

		expect(spy).not.toHaveBeenCalled();
	});

	it("falls back to USERPROFILE when HOME is missing", () => {
		Reflect.deleteProperty(process.env, "HOME");
		process.env.USERPROFILE = "/tmp/userprofile";
		const spy = vi.spyOn(os, "homedir").mockReturnValue("/ignored");

		expect(expandUserPath("~/projects")).toBe("/tmp/userprofile/projects");
		expect(spy).not.toHaveBeenCalled();
	});

	it("uses os.homedir when neither HOME nor USERPROFILE is set", () => {
		Reflect.deleteProperty(process.env, "HOME");
		Reflect.deleteProperty(process.env, "USERPROFILE");

		const home = os.homedir();
		expect(expandUserPath("~")).toBe(home);
		expect(expandUserPath("~/tmp")).toBe(`${home}/tmp`);
	});

	it("returns non-tilde paths unchanged", () => {
		expect(expandUserPath("/absolute/path")).toBe("/absolute/path");
		expect(expandUserPath("relative/path")).toBe("relative/path");
	});
});

describe("validatePath with allowedExtensions", () => {
	it("rejects path with no extension when allowedExtensions is set", async () => {
		// Paths like "README" or "Makefile" have no dot; lastIndexOf(".") is -1,
		// and slice(-1) would wrongly use the last character as "extension".
		const allowed = new Set([".txt", ".json"]);
		await expect(
			validatePath("README", { allowedExtensions: allowed }),
		).rejects.toThrow(PathValidationError);
	});

	it("reports extension_not_allowed for path with no dot (not last character)", async () => {
		const allowed = new Set([".txt"]);
		try {
			await validatePath("noext", { allowedExtensions: allowed });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			const err = e as PathValidationError;
			expect(err.reason).toBe("extension_not_allowed");
			// Bug: implementation used to report "t" (last char) as the disallowed extension
			expect(err.message).not.toMatch(/extension not allowed: t$/i);
		}
	});

	it("uses basename for extension so .git in path is not treated as extension", async () => {
		const allowed = new Set([".txt"]);
		// Path with dot in directory name; file "README" has no extension
		try {
			await validatePath(".git/README", { allowedExtensions: allowed });
			expect.fail("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(PathValidationError);
			const msg = (e as PathValidationError).message;
			// Should report "(none)" or empty, not ".git" or ".git/README"
			expect(msg).not.toContain(".git/");
			expect(msg).not.toMatch(/extension not allowed: \.git/i);
		}
	});
});

describe("isWithinCwd", () => {
	it("normalizes cwd before comparing normalized paths", () => {
		vi.spyOn(process, "cwd").mockReturnValue("/tmp/project/../project");

		expect(isWithinCwd("/tmp/project/file.txt")).toBe(true);
		expect(isWithinCwd("/tmp/other/file.txt")).toBe(false);
	});
});
