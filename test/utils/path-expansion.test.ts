import { afterEach, describe, expect, it } from "vitest";
import { expandTildePath, getHomeDir } from "../../src/utils/path-expansion.js";

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
