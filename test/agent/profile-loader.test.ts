import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadAgentProfiles,
	loadAgentProfilesFromDirectory,
} from "../../src/agent/profile-loader.js";

function fixtureDir(): string {
	const root = mkdtempSync(join(tmpdir(), "maestro-profiles-"));
	const profiles = join(root, ".maestro", "agent-profiles");
	mkdirSync(profiles, { recursive: true });
	return profiles;
}

describe("agent profile loader", () => {
	it("loads a complete declarative profile", () => {
		const directory = fixtureDir();
		writeFileSync(
			join(directory, "security-review.yaml"),
			`id: security-review-v1
version: 1
level: high
description: Cross-provider security review
primary:
  provider: openai-codex
  model: gpt-5.5
  reasoningEffort: high
oracle:
  provider: anthropic
  model: claude-opus-4-6
  reasoningEffort: high
  readOnly: true
fallbackLevels: [medium, low]
budgets:
  maxAttempts: 2
  maxToolCalls: 40
`,
		);

		expect(loadAgentProfilesFromDirectory(directory)).toContainEqual(
			expect.objectContaining({
				id: "security-review-v1",
				level: "high",
				oracle: expect.objectContaining({ readOnly: true }),
			}),
		);
	});

	it("rejects profiles without a read-only oracle", () => {
		const directory = fixtureDir();
		writeFileSync(
			join(directory, "invalid.yaml"),
			`id: invalid-v1
version: 1
level: medium
description: Invalid profile
primary: { provider: openai, model: gpt-5.5, reasoningEffort: medium }
oracle: { provider: anthropic, model: claude-opus, reasoningEffort: high }
fallbackLevels: [low]
budgets: { maxAttempts: 2, maxToolCalls: 20 }
`,
		);

		expect(() => loadAgentProfilesFromDirectory(directory)).toThrow(
			/oracle.readOnly/,
		);
	});

	it("lets project profiles override user profiles by id", () => {
		const root = mkdtempSync(join(tmpdir(), "maestro-profile-precedence-"));
		const homeDir = join(root, "home");
		const workspaceDir = join(root, "workspace");
		const userProfiles = join(homeDir, "agent-profiles");
		const projectProfiles = join(workspaceDir, ".maestro", "agent-profiles");
		mkdirSync(userProfiles, { recursive: true });
		mkdirSync(projectProfiles, { recursive: true });
		const profile = (description: string) => `id: review-v1
version: 1
level: high
description: ${description}
primary: { provider: openai, model: gpt-5.5, reasoningEffort: high }
oracle: { provider: anthropic, model: claude-opus, reasoningEffort: high, readOnly: true }
fallbackLevels: [medium]
budgets: { maxAttempts: 2, maxToolCalls: 20 }
`;
		writeFileSync(join(userProfiles, "review.yaml"), profile("User profile"));
		writeFileSync(
			join(projectProfiles, "review.yaml"),
			profile("Project profile"),
		);

		expect(loadAgentProfiles({ homeDir, workspaceDir })).toMatchObject([
			{ id: "review-v1", description: "Project profile" },
		]);
	});
});
