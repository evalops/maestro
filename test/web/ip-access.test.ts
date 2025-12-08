import { describe, expect, it } from "vitest";
import {
	type IpAccessConfig,
	checkIpAccess,
} from "../../src/server/server-middlewares.js";

describe("IP Access Control", () => {
	describe("checkIpAccess", () => {
		it("should allow IP in allowlist", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.1.100", type: "allow" }],
			};

			const result = checkIpAccess("192.168.1.100", config);
			expect(result.allowed).toBe(true);
			expect(result.matchedRule?.pattern).toBe("192.168.1.100");
		});

		it("should deny IP in blocklist", () => {
			const config: IpAccessConfig = {
				defaultAction: "allow",
				rules: [{ pattern: "10.0.0.1", type: "deny" }],
			};

			const result = checkIpAccess("10.0.0.1", config);
			expect(result.allowed).toBe(false);
		});

		it("should match CIDR /16 range", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.0.0/16", type: "allow" }],
			};

			expect(checkIpAccess("192.168.0.1", config).allowed).toBe(true);
			expect(checkIpAccess("192.168.1.50", config).allowed).toBe(true);
			expect(checkIpAccess("192.168.255.255", config).allowed).toBe(true);
			expect(checkIpAccess("192.169.0.1", config).allowed).toBe(false);
			expect(checkIpAccess("10.0.0.1", config).allowed).toBe(false);
		});

		it("should match CIDR /24 range", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "10.10.10.0/24", type: "allow" }],
			};

			expect(checkIpAccess("10.10.10.0", config).allowed).toBe(true);
			expect(checkIpAccess("10.10.10.1", config).allowed).toBe(true);
			expect(checkIpAccess("10.10.10.255", config).allowed).toBe(true);
			expect(checkIpAccess("10.10.11.0", config).allowed).toBe(false);
			expect(checkIpAccess("10.10.9.255", config).allowed).toBe(false);
		});

		it("should match CIDR /32 (single IP)", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "1.2.3.4/32", type: "allow" }],
			};

			expect(checkIpAccess("1.2.3.4", config).allowed).toBe(true);
			expect(checkIpAccess("1.2.3.5", config).allowed).toBe(false);
		});

		it("should match CIDR /8 range", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "10.0.0.0/8", type: "allow" }],
			};

			expect(checkIpAccess("10.0.0.1", config).allowed).toBe(true);
			expect(checkIpAccess("10.255.255.255", config).allowed).toBe(true);
			expect(checkIpAccess("11.0.0.1", config).allowed).toBe(false);
		});

		it("should use default action when no rules match", () => {
			const allowConfig: IpAccessConfig = {
				defaultAction: "allow",
				rules: [],
			};
			const denyConfig: IpAccessConfig = {
				defaultAction: "deny",
				rules: [],
			};

			expect(checkIpAccess("1.2.3.4", allowConfig).allowed).toBe(true);
			expect(checkIpAccess("1.2.3.4", denyConfig).allowed).toBe(false);
		});

		it("should evaluate rules in order (first match wins)", () => {
			const config: IpAccessConfig = {
				defaultAction: "allow",
				rules: [
					{ pattern: "192.168.1.100", type: "deny", description: "Blocked IP" },
					{
						pattern: "192.168.1.0/24",
						type: "allow",
						description: "Office subnet",
					},
				],
			};

			// Specific IP should be denied even though subnet allows
			expect(checkIpAccess("192.168.1.100", config).allowed).toBe(false);
			expect(
				checkIpAccess("192.168.1.100", config).matchedRule?.description,
			).toBe("Blocked IP");

			// Other IPs in subnet should be allowed
			expect(checkIpAccess("192.168.1.50", config).allowed).toBe(true);
			expect(
				checkIpAccess("192.168.1.50", config).matchedRule?.description,
			).toBe("Office subnet");
		});

		it("should handle IPv4-mapped IPv6 addresses", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.1.1", type: "allow" }],
			};

			expect(checkIpAccess("::ffff:192.168.1.1", config).allowed).toBe(true);
			expect(checkIpAccess("::ffff:192.168.1.2", config).allowed).toBe(false);
		});

		it("should return matchedRule info", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [
					{
						pattern: "10.0.0.0/8",
						type: "allow",
						description: "Private network",
					},
				],
			};

			const result = checkIpAccess("10.5.5.5", config);
			expect(result.allowed).toBe(true);
			expect(result.matchedRule?.pattern).toBe("10.0.0.0/8");
			expect(result.matchedRule?.description).toBe("Private network");
		});

		it("should handle invalid IP addresses gracefully", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [{ pattern: "192.168.1.0/24", type: "allow" }],
			};

			// Invalid IPs should not match any rule
			expect(checkIpAccess("invalid", config).allowed).toBe(false);
			expect(checkIpAccess("", config).allowed).toBe(false);
			expect(checkIpAccess("256.1.1.1", config).allowed).toBe(false);
			expect(checkIpAccess("1.2.3", config).allowed).toBe(false);
		});

		it("should handle complex rule sets", () => {
			const config: IpAccessConfig = {
				defaultAction: "deny",
				rules: [
					// Block specific bad actors
					{
						pattern: "203.0.113.50",
						type: "deny",
						description: "Known attacker",
					},
					{
						pattern: "203.0.113.51",
						type: "deny",
						description: "Known attacker",
					},
					// Allow office subnets
					{ pattern: "192.168.1.0/24", type: "allow", description: "Office A" },
					{ pattern: "192.168.2.0/24", type: "allow", description: "Office B" },
					// Allow VPN range
					{ pattern: "10.8.0.0/16", type: "allow", description: "VPN" },
				],
			};

			// Bad actors blocked
			expect(checkIpAccess("203.0.113.50", config).allowed).toBe(false);

			// Office allowed
			expect(checkIpAccess("192.168.1.100", config).allowed).toBe(true);
			expect(checkIpAccess("192.168.2.50", config).allowed).toBe(true);

			// VPN allowed
			expect(checkIpAccess("10.8.0.1", config).allowed).toBe(true);
			expect(checkIpAccess("10.8.255.255", config).allowed).toBe(true);

			// Everything else denied
			expect(checkIpAccess("8.8.8.8", config).allowed).toBe(false);
			expect(checkIpAccess("192.168.3.1", config).allowed).toBe(false);
		});
	});
});
