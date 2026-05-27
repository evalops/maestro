import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({
	lookupMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
	lookup: lookupMock,
}));

import { checkNetworkRestrictionsDetailed } from "../../src/safety/validators/network-policy-validator.js";

describe("network policy validator", () => {
	beforeEach(() => {
		lookupMock.mockReset();
	});

	it("blocks empty allowlists before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://any-host.invalid/api",
			{ allowedHosts: [] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("not in the allowed hosts list");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks hosts outside a non-empty allowlist before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://example.com/api",
			{ allowedHosts: ["api.github.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("not in the allowed hosts list");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("blocks denylisted hosts before resolving DNS", async () => {
		const result = await checkNetworkRestrictionsDetailed(
			"https://api.evil.com/data",
			{ blockedHosts: ["evil.com"] },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("blocked by enterprise policy");
		expect(result.resolvedIPs).toEqual([]);
		expect(lookupMock).not.toHaveBeenCalled();
	});

	it("still resolves allowed hosts when private IP checks are enabled", async () => {
		lookupMock.mockResolvedValueOnce([{ address: "10.0.0.1", family: 4 }]);

		const result = await checkNetworkRestrictionsDetailed(
			"https://api.github.com/repos",
			{ allowedHosts: ["api.github.com"], blockPrivateIPs: true },
		);

		expect(result.allowed).toBe(false);
		expect(result.reason).toContain("private IP addresses");
		expect(result.resolvedIPs).toEqual(["10.0.0.1"]);
		expect(lookupMock).toHaveBeenCalledWith("api.github.com", { all: true });
	});
});
