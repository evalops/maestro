import { afterEach, describe, expect, it } from "vitest";
import {
	expandTildePath,
	getHomeDir,
	resolveEnvPath,
} from "../../src/utils/path-expansion.js";

describe("path-expansion", () => {
	const originalHome = process.env.HOME;
	const originalUserProfile = process.env.USERPROFILE;

	afterEach(() => {
		process.env.HOME = originalHome;
		process.env.USERPROFILE = originalUserProfile;
	});

	it("prefers HOME over USERPROFILE", () => {
		process.env.HOME = "/tmp/home";
		process.env.USERPROFILE = "/tmp/profile";
		expect(getHomeDir()).toBe("/tmp/home");
	});

	it("uses USERPROFILE when HOME is missing", () => {
		process.env.HOME = "";
		process.env.USERPROFILE = "/tmp/profile";
		expect(getHomeDir()).toBe("/tmp/profile");
	});

	it("uses USERPROFILE when HOME is whitespace-only (trim yields empty)", () => {
		process.env.HOME = "   ";
		process.env.USERPROFILE = "/tmp/profile";
		expect(getHomeDir()).toBe("/tmp/profile");
	});

	it("expands ~ and ~/ paths", () => {
		process.env.HOME = "/tmp/home";
		expect(expandTildePath("~")).toBe("/tmp/home");
		expect(expandTildePath("~/projects")).toBe("/tmp/home/projects");
	});

	it("does not expand ~prefix paths (e.g. ~user)", () => {
		process.env.HOME = "/tmp/home";
		expect(expandTildePath("~foo")).toBe("~foo");
	});

	it("expands ~\\ paths too", () => {
		process.env.HOME = "/tmp/home";
		expect(expandTildePath("~\\projects")).toBe("/tmp/home/projects");
	});
});

describe("resolveEnvPath", () => {
	it("returns null for undefined, null, empty string, and whitespace-only", () => {
		expect(resolveEnvPath(undefined)).toBeNull();
		expect(resolveEnvPath(null)).toBeNull();
		expect(resolveEnvPath("")).toBeNull();
		expect(resolveEnvPath("   ")).toBeNull();
	});

	it("trims and resolves path with leading/trailing whitespace", () => {
		process.env.HOME = "/tmp/home";
		const result = resolveEnvPath("  ~/foo  ");
		expect(result).toBe("/tmp/home/foo");
	});

	it("resolves absolute path unchanged", () => {
		const result = resolveEnvPath("  /absolute/path  ");
		expect(result).toBe("/absolute/path");
	});
});
