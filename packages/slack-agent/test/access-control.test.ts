import { describe, expect, it } from "vitest";
import {
	getHostSandboxGateError,
	isSlackUserAllowed,
	parseSlackUserAllowList,
} from "../src/access-control.js";

describe("Slack agent access control", () => {
	it("treats an empty user allow-list as unrestricted", () => {
		const allowList = parseSlackUserAllowList(undefined);
		expect(isSlackUserAllowed("U123", allowList)).toBe(true);
	});

	it("allows only configured Slack user IDs when an allow-list is set", () => {
		const allowList = parseSlackUserAllowList(" U123, U456 ,, ");
		expect(isSlackUserAllowed("U123", allowList)).toBe(true);
		expect(isSlackUserAllowed("U456", allowList)).toBe(true);
		expect(isSlackUserAllowed("U789", allowList)).toBe(false);
	});

	it("blocks host sandbox unless explicitly allowed", () => {
		expect(getHostSandboxGateError({ type: "host" }, false)).toContain(
			"Host sandbox mode is disabled",
		);
		expect(getHostSandboxGateError({ type: "host" }, true)).toBeNull();
	});

	it("does not gate isolated sandbox modes", () => {
		expect(
			getHostSandboxGateError({ type: "docker", autoCreate: true }, false),
		).toBeNull();
		expect(getHostSandboxGateError({ type: "daytona" }, false)).toBeNull();
	});
});
