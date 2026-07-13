import { describe, expect, it } from "vitest";
import {
	AGENT_PROFILES,
	parseAgentProfileLevel,
	resolveAgentProfile,
} from "../../src/agent/profiles.js";

describe("agent profiles", () => {
	it("maps legacy modes to canonical capability levels", () => {
		expect(parseAgentProfileLevel("free")).toBe("low");
		expect(parseAgentProfileLevel("rush")).toBe("low");
		expect(parseAgentProfileLevel("smart")).toBe("medium");
		expect(parseAgentProfileLevel("frontier")).toBe("ultra");
	});

	it("accepts canonical capability levels case-insensitively", () => {
		expect(parseAgentProfileLevel("LOW")).toBe("low");
		expect(parseAgentProfileLevel("High")).toBe("high");
		expect(parseAgentProfileLevel("unknown")).toBeNull();
	});

	it("defines immutable, versioned profiles", () => {
		expect(Object.isFrozen(AGENT_PROFILES)).toBe(true);
		expect(AGENT_PROFILES.medium.id).toBe("medium-v1");
		expect(AGENT_PROFILES.medium.version).toBe(1);
		expect(Object.isFrozen(AGENT_PROFILES.medium)).toBe(true);
	});

	it("resolves a complete profile with a complementary oracle", () => {
		expect(resolveAgentProfile("high", "openai-codex")).toMatchObject({
			id: "high-v1",
			level: "high",
			primary: {
				provider: "openai-codex",
				reasoningEffort: "xhigh",
			},
			oracle: {
				provider: "anthropic",
				reasoningEffort: "high",
				readOnly: true,
			},
			fallbackLevels: ["medium", "low"],
		});
	});

	it("resolves legacy aliases to their canonical profile", () => {
		expect(resolveAgentProfile("rush", "anthropic")).toMatchObject({
			id: "low-v1",
			level: "low",
			primary: { provider: "anthropic", reasoningEffort: "low" },
		});
	});
});
