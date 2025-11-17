import { parse as partialParse } from "partial-json";

/**
 * Attempts to parse potentially incomplete JSON during streaming.
 * Always returns a valid object, even if the JSON is incomplete.
 *
 * This is critical for progressive UI updates during tool call streaming,
 * allowing users to see partial arguments (like file paths) before the
 * complete JSON is received.
 *
 * @param partialJson The partial JSON string from streaming
 * @returns Parsed object or empty object if parsing fails
 *
 * @example
 * parseStreamingJson('{"path": "/file.txt", "con')
 * // => { path: "/file.txt" }
 *
 * parseStreamingJson('{"path": "/file.txt", "content": "Hello')
 * // => { path: "/file.txt", content: "Hello" }
 */
export function parseStreamingJson<T = any>(
	partialJson: string | undefined,
): T {
	if (!partialJson || partialJson.trim() === "") {
		return {} as T;
	}

	// Try standard parsing first (fastest for complete JSON)
	try {
		return JSON.parse(partialJson) as T;
	} catch {
		// Try partial-json for incomplete JSON
		try {
			const result = partialParse(partialJson);
			return (result ?? {}) as T;
		} catch {
			// If all parsing fails, return empty object
			return {} as T;
		}
	}
}
