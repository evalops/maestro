/**
 * URL Extraction Utilities
 *
 * Extracts URLs from text, objects, and shell commands.
 * Used for security policy enforcement and content analysis.
 *
 * ## Features
 *
 * - Recursive extraction from nested objects/arrays
 * - Shell command parsing (curl, wget)
 * - Automatic http:// prefix for bare hostnames
 * - Trailing punctuation cleanup
 *
 * @module utils/url-extractor
 */

/**
 * Pattern to match HTTP/HTTPS URLs in text.
 */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

/**
 * Pattern to extract arguments from curl/wget commands.
 */
const CURL_WGET_PATTERN =
	/(?:curl|wget)\s+((?:[^\s;&|<>`$()]|\\.)+(?:\s+(?:[^\s;&|<>`$()]|\\.)+)*)/gi;

/**
 * Extract URLs from any value recursively.
 *
 * Handles strings, arrays, and objects. URLs are cleaned of trailing
 * punctuation that commonly gets captured in regex matches.
 *
 * @example
 * extractUrlsFromValue("Check https://example.com for details")
 * // Returns: ["https://example.com"]
 *
 * extractUrlsFromValue({ url: "https://api.example.com", nested: { link: "https://other.com" } })
 * // Returns: ["https://api.example.com", "https://other.com"]
 *
 * @param value - Value to extract URLs from (string, array, or object)
 * @returns Array of extracted URLs
 */
export function extractUrlsFromValue(value: unknown): string[] {
	const urls: string[] = [];

	function extract(val: unknown): void {
		if (typeof val === "string") {
			const matches = val.match(URL_PATTERN);
			if (matches) {
				for (const match of matches) {
					// Trim common trailing punctuation that gets captured
					urls.push(match.replace(/[)}\],.;:]+$/, ""));
				}
			}
		} else if (Array.isArray(val)) {
			for (const item of val) {
				extract(item);
			}
		} else if (val && typeof val === "object") {
			for (const v of Object.values(val)) {
				extract(v);
			}
		}
	}

	extract(value);
	return urls;
}

/**
 * Extract URLs from curl/wget shell commands.
 *
 * Parses command arguments and extracts URL-like strings.
 * Automatically adds http:// prefix for bare hostnames.
 *
 * @example
 * extractUrlsFromShellCommand("curl https://api.example.com/data")
 * // Returns: ["https://api.example.com/data"]
 *
 * extractUrlsFromShellCommand("wget example.com/file.txt")
 * // Returns: ["http://example.com/file.txt"]
 *
 * extractUrlsFromShellCommand("curl -X POST https://api.example.com -d '{}'")
 * // Returns: ["https://api.example.com"]
 *
 * @param command - Shell command string
 * @returns Array of extracted URLs
 */
export function extractUrlsFromShellCommand(command: string): string[] {
	const urls: string[] = [];

	const matches = command.matchAll(new RegExp(CURL_WGET_PATTERN));
	for (const match of matches) {
		const argsStr = match[1];
		// Split by spaces, respecting quotes
		const argParts = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

		for (const arg of argParts) {
			let url = arg.replace(/^["']|["']$/g, ""); // strip quotes

			// Skip flags
			if (url.startsWith("-")) continue;

			// Add http:// if no protocol specified
			if (url && !/^https?:\/\//i.test(url)) {
				url = `http://${url}`;
			}
			if (url) {
				urls.push(url.replace(/[)}\],.;:]+$/, ""));
			}
		}
	}

	return urls;
}

/**
 * Extract all URLs from text, objects, and embedded shell commands.
 *
 * Combines URL extraction from values and shell command parsing.
 * Use this when you need comprehensive URL extraction from mixed content.
 *
 * @param value - Value to extract URLs from
 * @param shellCommand - Optional shell command to also parse
 * @returns Array of all extracted URLs (deduplicated)
 */
export function extractAllUrls(
	value: unknown,
	shellCommand?: string,
): string[] {
	const urls = extractUrlsFromValue(value);

	if (shellCommand) {
		urls.push(...extractUrlsFromShellCommand(shellCommand));
	}

	// Deduplicate
	return [...new Set(urls)];
}
