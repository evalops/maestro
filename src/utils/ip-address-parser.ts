/**
 * IP Address Parsing Utilities
 *
 * Functions for parsing and validating IPv4 and IPv6 addresses,
 * including detection of private/loopback ranges.
 *
 * ## Supported Formats
 *
 * - IPv4: 192.168.1.1
 * - IPv6 loopback: ::1
 * - IPv4-mapped IPv6: ::ffff:192.168.1.1 or ::ffff:c0a8:0101
 * - IPv6 link-local: fe80::1
 * - IPv6 private: fc00::/7, fd00::/8
 */

/**
 * Parse an IPv4 address and validate octets are in range 0-255.
 *
 * Rejects addresses with:
 * - Wrong number of octets
 * - Non-numeric octets
 * - Octets out of range (0-255)
 * - Leading zeros (e.g., "01.02.03.04")
 *
 * @param host - IPv4 address string (e.g., "192.168.1.1")
 * @returns Array of 4 octets if valid, null otherwise
 */
export function parseIPv4(host: string): number[] | null {
	const parts = host.split(".");
	if (parts.length !== 4) return null;

	const octets: number[] = [];
	for (const part of parts) {
		const num = Number.parseInt(part, 10);
		if (Number.isNaN(num) || num < 0 || num > 255 || String(num) !== part) {
			return null; // Invalid octet or leading zeros
		}
		octets.push(num);
	}
	return octets;
}

/**
 * Check if an IPv4 address is in the localhost range (127.0.0.0/8).
 *
 * @param octets - Array of 4 octets from parseIPv4
 * @returns true if loopback address
 */
export function isLoopbackIPv4(octets: number[]): boolean {
	return octets[0] === 127;
}

/**
 * Check if an IPv4 address is in a private/reserved range.
 *
 * Detected ranges:
 * - 10.0.0.0/8 (Class A private)
 * - 172.16.0.0/12 (Class B private)
 * - 192.168.0.0/16 (Class C private)
 * - 169.254.0.0/16 (link-local)
 * - 100.64.0.0/10 (carrier-grade NAT)
 *
 * @param octets - Array of 4 octets from parseIPv4
 * @returns true if private/reserved address
 */
export function isPrivateIPv4(octets: number[]): boolean {
	const a = octets[0];
	const b = octets[1];
	if (a === undefined || b === undefined) return false;
	return (
		a === 10 || // 10.0.0.0/8
		(a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
		(a === 192 && b === 168) || // 192.168.0.0/16
		(a === 169 && b === 254) || // 169.254.0.0/16 link-local
		(a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 carrier-grade NAT
	);
}

/**
 * Parse an IPv4-mapped IPv6 address in hex format.
 *
 * Handles the format: ::ffff:XXXX:XXXX where XXXX are hex values
 * representing pairs of IPv4 octets.
 *
 * Example: ::ffff:c0a8:0101 → [192, 168, 1, 1]
 *
 * @param host - IPv6 address string
 * @returns Array of 4 IPv4 octets if valid mapped address, null otherwise
 */
export function parseIPv4MappedHex(host: string): number[] | null {
	// Match ::ffff:XXXX:XXXX format (hex representation of IPv4)
	const match = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
	if (!match || !match[1] || !match[2]) return null;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);

	if (Number.isNaN(high) || Number.isNaN(low)) return null;

	// Convert to octets: high = (octet1 << 8) | octet2, low = (octet3 << 8) | octet4
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}

/**
 * Parse an IPv4-mapped IPv6 address in dotted-decimal format.
 *
 * Handles the format: ::ffff:X.X.X.X
 *
 * Example: ::ffff:192.168.1.1 → [192, 168, 1, 1]
 *
 * @param host - IPv6 address string
 * @returns Array of 4 IPv4 octets if valid mapped address, null otherwise
 */
export function parseIPv4MappedDecimal(host: string): number[] | null {
	const match = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
	if (!match || !match[1]) return null;
	return parseIPv4(match[1]);
}

/**
 * Check if an IP address string is a loopback address.
 *
 * Detects:
 * - IPv4 loopback: 127.0.0.0/8
 * - IPv6 loopback: ::1 (and expanded forms)
 * - IPv4-mapped loopback: ::ffff:127.x.x.x
 *
 * @param ip - IP address string (IPv4 or IPv6)
 * @returns true if loopback address
 */
export function isLoopbackIP(ip: string): boolean {
	// Check IPv4 localhost
	const ipv4Octets = parseIPv4(ip);
	if (ipv4Octets && isLoopbackIPv4(ipv4Octets)) return true;

	// Check IPv4-mapped localhost (hex format)
	const mappedHexOctets = parseIPv4MappedHex(ip);
	if (mappedHexOctets && isLoopbackIPv4(mappedHexOctets)) return true;

	// Check IPv4-mapped localhost (decimal format)
	const mappedDecimalOctets = parseIPv4MappedDecimal(ip);
	if (mappedDecimalOctets && isLoopbackIPv4(mappedDecimalOctets)) return true;

	// Check IPv6 loopback variants
	if (
		ip === "::1" ||
		/^0*:0*:0*:0*:0*:0*:0*:0*1$/i.test(ip) ||
		/^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(ip)
	) {
		return true;
	}

	return false;
}

/**
 * Check if an IP address string is a private/internal address.
 *
 * Detects:
 * - IPv4 private ranges: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * - IPv4 link-local: 169.254.0.0/16
 * - IPv4 carrier-grade NAT: 100.64.0.0/10
 * - IPv6 link-local: fe80::/10
 * - IPv6 unique local: fc00::/7 (includes fd00::/8)
 * - IPv4-mapped private addresses
 *
 * @param ip - IP address string (IPv4 or IPv6)
 * @returns true if private/internal address
 */
export function isPrivateIP(ip: string): boolean {
	// Check IPv4 private
	const ipv4Octets = parseIPv4(ip);
	if (ipv4Octets && isPrivateIPv4(ipv4Octets)) return true;

	// Check IPv4-mapped private (hex format)
	const mappedHexOctets = parseIPv4MappedHex(ip);
	if (mappedHexOctets && isPrivateIPv4(mappedHexOctets)) return true;

	// Check IPv4-mapped private (decimal format)
	const mappedDecimalOctets = parseIPv4MappedDecimal(ip);
	if (mappedDecimalOctets && isPrivateIPv4(mappedDecimalOctets)) return true;

	// Check IPv6 private ranges
	if (
		/^fe80:/i.test(ip) || // Link-local
		/^fc[0-9a-f]{2}:/i.test(ip) || // Unique local (fc00::/7 part 1)
		/^fd[0-9a-f]{0,2}:/i.test(ip) // Unique local (fd00::/8)
	) {
		return true;
	}

	return false;
}

/**
 * Check if a hostname is a localhost alias.
 *
 * @param hostname - Hostname to check (should be lowercase)
 * @returns true if localhost alias
 */
export function isLocalhostAlias(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "localhost.localdomain" ||
		hostname === "0.0.0.0"
	);
}
