import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { expandUserPath } from "../../src/utils/path-validation.js";

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
