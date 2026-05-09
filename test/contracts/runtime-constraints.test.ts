import {
	buildRuntimeConstraintPrompt,
	getRuntimeConstraintFragments,
	isSandboxModeEnabled,
} from "@evalops/contracts";
import { describe, expect, it } from "vitest";

describe("runtime constraint fragments", () => {
	it("injects shallow-git guidance only for sandboxed shallow checkouts", () => {
		expect(
			getRuntimeConstraintFragments({
				sandboxMode: "workspace-write",
				isShallowGitCheckout: true,
			}).map((fragment) => fragment.contextKey),
		).toContain("sandbox.shallow-git");

		expect(
			getRuntimeConstraintFragments({
				sandboxMode: "none",
				isShallowGitCheckout: true,
			}).map((fragment) => fragment.contextKey),
		).not.toContain("sandbox.shallow-git");
	});

	it("lets resolved sandbox state override requested sandbox mode", () => {
		expect(
			getRuntimeConstraintFragments({
				sandboxMode: "native",
				sandboxEnabled: false,
				isShallowGitCheckout: true,
			}).map((fragment) => fragment.contextKey),
		).not.toContain("sandbox.filesystem");
	});

	it("warns offline evals to skip network-dependent search", () => {
		const prompt = buildRuntimeConstraintPrompt({
			networkAccess: "disabled",
		});

		expect(prompt).toContain("# Runtime Constraints");
		expect(prompt).toContain("network.offline");
		expect(prompt).toContain("skip web search");
		expect(prompt).toContain("network requests are expected to fail");
	});

	it("suppresses restricted-network guidance when offline mode is active", () => {
		expect(
			getRuntimeConstraintFragments({
				networkAccess: "disabled",
				firewallRestricted: true,
			}).map((fragment) => fragment.contextKey),
		).toEqual(["network.offline"]);
	});

	it("covers hosted, firewall-restricted, and read-only contexts", () => {
		expect(
			getRuntimeConstraintFragments({
				hostedRunner: true,
				firewallRestricted: true,
				readOnly: true,
			}).map((fragment) => fragment.contextKey),
		).toEqual([
			"hosted-runner.ephemeral",
			"network.restricted",
			"checkout.read-only",
		]);
	});

	it("treats only sandboxed modes as enabled", () => {
		expect(isSandboxModeEnabled("workspace-write")).toBe(true);
		expect(isSandboxModeEnabled("read-only")).toBe(true);
		expect(isSandboxModeEnabled(" danger-full-access ")).toBe(false);
		expect(isSandboxModeEnabled("local")).toBe(false);
		expect(isSandboxModeEnabled("none")).toBe(false);
	});

	it("omits fragments when no runtime constraints apply", () => {
		expect(buildRuntimeConstraintPrompt({ networkAccess: "available" })).toBe(
			"",
		);
	});
});
