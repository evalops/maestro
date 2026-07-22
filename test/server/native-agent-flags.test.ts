import { describe, expect, it } from "vitest";
import { isNativeMemoryEnabled } from "../../src/server/native-agent-flags.js";

describe("native-agent-flags", () => {
	it("allows native memory scheduling to be disabled", () => {
		expect(isNativeMemoryEnabled({})).toBe(true);
		expect(isNativeMemoryEnabled({ MAESTRO_NATIVE_MEMORY: "0" })).toBe(false);
		expect(isNativeMemoryEnabled({ MAESTRO_NATIVE_MEMORY: "off" })).toBe(false);
		expect(isNativeMemoryEnabled({ MAESTRO_NATIVE_MEMORY: "1" })).toBe(true);
	});
});
