import { describe, expect, it } from "vitest";
import {
	isLoopbackIPv4,
	isPrivateIPv4,
	parseIPv4,
	parseIPv4MappedHex,
} from "../../src/utils/ip-address-parser.js";

describe("parseIPv4", () => {
	it("parses valid IPv4 addresses", () => {
		expect(parseIPv4("0.0.0.0")).toEqual([0, 0, 0, 0]);
		expect(parseIPv4("127.0.0.1")).toEqual([127, 0, 0, 1]);
		expect(parseIPv4("192.168.1.1")).toEqual([192, 168, 1, 1]);
		expect(parseIPv4("255.255.255.255")).toEqual([255, 255, 255, 255]);
		expect(parseIPv4("10.0.0.1")).toEqual([10, 0, 0, 1]);
	});

	it("returns null for invalid octet count", () => {
		expect(parseIPv4("192.168.1")).toBeNull();
		expect(parseIPv4("192.168.1.1.1")).toBeNull();
		expect(parseIPv4("192.168")).toBeNull();
		expect(parseIPv4("192")).toBeNull();
		expect(parseIPv4("")).toBeNull();
	});

	it("returns null for octets out of range", () => {
		expect(parseIPv4("256.0.0.0")).toBeNull();
		expect(parseIPv4("0.256.0.0")).toBeNull();
		expect(parseIPv4("0.0.256.0")).toBeNull();
		expect(parseIPv4("0.0.0.256")).toBeNull();
		expect(parseIPv4("-1.0.0.0")).toBeNull();
	});

	it("returns null for leading zeros (security: octal interpretation)", () => {
		expect(parseIPv4("01.02.03.04")).toBeNull();
		expect(parseIPv4("192.168.01.1")).toBeNull();
		expect(parseIPv4("192.168.1.01")).toBeNull();
		expect(parseIPv4("00.0.0.0")).toBeNull();
	});

	it("returns null for non-numeric octets", () => {
		expect(parseIPv4("a.b.c.d")).toBeNull();
		expect(parseIPv4("192.168.1.a")).toBeNull();
		expect(parseIPv4("192.168.1.1a")).toBeNull();
		expect(parseIPv4("192.168.1. 1")).toBeNull();
		expect(parseIPv4("192.168.1.")).toBeNull();
		expect(parseIPv4(".168.1.1")).toBeNull();
	});

	it("returns null for floating point values", () => {
		expect(parseIPv4("192.168.1.1.5")).toBeNull();
	});

	it("returns null for empty octets", () => {
		expect(parseIPv4("192..1.1")).toBeNull();
		expect(parseIPv4("...")).toBeNull();
	});
});

describe("isLoopbackIPv4", () => {
	it("returns true for 127.x.x.x addresses", () => {
		expect(isLoopbackIPv4([127, 0, 0, 1])).toBe(true);
		expect(isLoopbackIPv4([127, 0, 0, 0])).toBe(true);
		expect(isLoopbackIPv4([127, 255, 255, 255])).toBe(true);
		expect(isLoopbackIPv4([127, 1, 2, 3])).toBe(true);
	});

	it("returns false for non-loopback addresses", () => {
		expect(isLoopbackIPv4([126, 0, 0, 1])).toBe(false);
		expect(isLoopbackIPv4([128, 0, 0, 1])).toBe(false);
		expect(isLoopbackIPv4([192, 168, 1, 1])).toBe(false);
		expect(isLoopbackIPv4([10, 0, 0, 1])).toBe(false);
		expect(isLoopbackIPv4([0, 0, 0, 0])).toBe(false);
	});
});

describe("isPrivateIPv4", () => {
	describe("10.0.0.0/8 (Class A private)", () => {
		it("returns true for 10.x.x.x addresses", () => {
			expect(isPrivateIPv4([10, 0, 0, 0])).toBe(true);
			expect(isPrivateIPv4([10, 0, 0, 1])).toBe(true);
			expect(isPrivateIPv4([10, 255, 255, 255])).toBe(true);
			expect(isPrivateIPv4([10, 100, 50, 25])).toBe(true);
		});
	});

	describe("172.16.0.0/12 (Class B private)", () => {
		it("returns true for 172.16-31.x.x addresses", () => {
			expect(isPrivateIPv4([172, 16, 0, 0])).toBe(true);
			expect(isPrivateIPv4([172, 16, 0, 1])).toBe(true);
			expect(isPrivateIPv4([172, 31, 255, 255])).toBe(true);
			expect(isPrivateIPv4([172, 20, 10, 5])).toBe(true);
		});

		it("returns false for 172.0-15.x.x and 172.32+.x.x", () => {
			expect(isPrivateIPv4([172, 15, 0, 0])).toBe(false);
			expect(isPrivateIPv4([172, 32, 0, 0])).toBe(false);
			expect(isPrivateIPv4([172, 0, 0, 0])).toBe(false);
		});
	});

	describe("192.168.0.0/16 (Class C private)", () => {
		it("returns true for 192.168.x.x addresses", () => {
			expect(isPrivateIPv4([192, 168, 0, 0])).toBe(true);
			expect(isPrivateIPv4([192, 168, 0, 1])).toBe(true);
			expect(isPrivateIPv4([192, 168, 255, 255])).toBe(true);
			expect(isPrivateIPv4([192, 168, 1, 100])).toBe(true);
		});

		it("returns false for 192.x (non-168).x.x", () => {
			expect(isPrivateIPv4([192, 167, 0, 0])).toBe(false);
			expect(isPrivateIPv4([192, 169, 0, 0])).toBe(false);
			expect(isPrivateIPv4([192, 0, 0, 0])).toBe(false);
		});
	});

	describe("169.254.0.0/16 (link-local)", () => {
		it("returns true for 169.254.x.x addresses", () => {
			expect(isPrivateIPv4([169, 254, 0, 0])).toBe(true);
			expect(isPrivateIPv4([169, 254, 0, 1])).toBe(true);
			expect(isPrivateIPv4([169, 254, 255, 255])).toBe(true);
		});

		it("returns false for 169.x (non-254).x.x", () => {
			expect(isPrivateIPv4([169, 253, 0, 0])).toBe(false);
			expect(isPrivateIPv4([169, 255, 0, 0])).toBe(false);
		});
	});

	describe("100.64.0.0/10 (carrier-grade NAT)", () => {
		it("returns true for 100.64-127.x.x addresses", () => {
			expect(isPrivateIPv4([100, 64, 0, 0])).toBe(true);
			expect(isPrivateIPv4([100, 64, 0, 1])).toBe(true);
			expect(isPrivateIPv4([100, 127, 255, 255])).toBe(true);
			expect(isPrivateIPv4([100, 100, 50, 25])).toBe(true);
		});

		it("returns false for 100.0-63.x.x and 100.128+.x.x", () => {
			expect(isPrivateIPv4([100, 63, 0, 0])).toBe(false);
			expect(isPrivateIPv4([100, 128, 0, 0])).toBe(false);
			expect(isPrivateIPv4([100, 0, 0, 0])).toBe(false);
		});
	});

	it("returns false for public addresses", () => {
		expect(isPrivateIPv4([8, 8, 8, 8])).toBe(false); // Google DNS
		expect(isPrivateIPv4([1, 1, 1, 1])).toBe(false); // Cloudflare DNS
		expect(isPrivateIPv4([142, 250, 185, 46])).toBe(false); // google.com
		expect(isPrivateIPv4([151, 101, 1, 140])).toBe(false); // reddit.com
	});
});

describe("parseIPv4MappedHex", () => {
	it("parses valid IPv4-mapped IPv6 addresses", () => {
		// ::ffff:c0a8:0101 = 192.168.1.1
		expect(parseIPv4MappedHex("::ffff:c0a8:101")).toEqual([192, 168, 1, 1]);
		expect(parseIPv4MappedHex("::ffff:c0a8:0101")).toEqual([192, 168, 1, 1]);

		// ::ffff:7f00:0001 = 127.0.0.1
		expect(parseIPv4MappedHex("::ffff:7f00:1")).toEqual([127, 0, 0, 1]);
		expect(parseIPv4MappedHex("::ffff:7f00:0001")).toEqual([127, 0, 0, 1]);

		// ::ffff:0a00:0001 = 10.0.0.1
		expect(parseIPv4MappedHex("::ffff:a00:1")).toEqual([10, 0, 0, 1]);

		// ::ffff:0:0 = 0.0.0.0
		expect(parseIPv4MappedHex("::ffff:0:0")).toEqual([0, 0, 0, 0]);

		// ::ffff:ffff:ffff = 255.255.255.255
		expect(parseIPv4MappedHex("::ffff:ffff:ffff")).toEqual([
			255, 255, 255, 255,
		]);
	});

	it("handles case insensitivity", () => {
		expect(parseIPv4MappedHex("::FFFF:C0A8:101")).toEqual([192, 168, 1, 1]);
		expect(parseIPv4MappedHex("::Ffff:c0A8:101")).toEqual([192, 168, 1, 1]);
	});

	it("returns null for invalid formats", () => {
		expect(parseIPv4MappedHex("192.168.1.1")).toBeNull();
		expect(parseIPv4MappedHex("::ffff:192.168.1.1")).toBeNull(); // dotted format
		expect(parseIPv4MappedHex("::c0a8:101")).toBeNull(); // missing ffff
		expect(parseIPv4MappedHex("ffff:c0a8:101")).toBeNull(); // missing ::
		expect(parseIPv4MappedHex("::ffff:c0a8")).toBeNull(); // only one hex group
		expect(parseIPv4MappedHex("::ffff:c0a8:101:1")).toBeNull(); // too many groups
		expect(parseIPv4MappedHex("")).toBeNull();
		expect(parseIPv4MappedHex("::ffff:gggg:0001")).toBeNull(); // invalid hex
	});

	it("returns null for hex values out of range", () => {
		expect(parseIPv4MappedHex("::ffff:10000:0001")).toBeNull();
		expect(parseIPv4MappedHex("::ffff:0001:10000")).toBeNull();
	});
});
