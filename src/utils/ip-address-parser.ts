/**
 * IP Address Parsing Utilities
 *
 * Functions for parsing and validating IPv4 addresses,
 * including detection of private/loopback ranges.
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
	const [a, b] = octets;
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
	if (!match) return null;

	const high = Number.parseInt(match[1], 16);
	const low = Number.parseInt(match[2], 16);

	if (Number.isNaN(high) || Number.isNaN(low)) return null;

	// Convert to octets: high = (octet1 << 8) | octet2, low = (octet3 << 8) | octet4
	return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff];
}
