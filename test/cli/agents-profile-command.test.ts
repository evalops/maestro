import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSpecialistProfile,
	getSpecialistProfilePath,
} from "../../src/agent/specialist-profiles.js";
import { handleAgentsProfileCommand } from "../../src/cli/commands/agents.js";

describe("cli/agents profile command", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("deletes user-scoped profiles when --scope user is provided", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-agents-cli-"));
		const homeDir = mkdtempSync(join(tmpdir(), "maestro-agents-home-"));
		const originalCwd = process.cwd();
		vi.stubEnv("MAESTRO_HOME", homeDir);
		vi.spyOn(console, "log").mockImplementation(() => {});
		process.chdir(workspaceDir);
		try {
			createSpecialistProfile({
				name: "api reviewer",
				prompt: "Project profile",
				scope: "project",
			});
			createSpecialistProfile({
				name: "api reviewer",
				prompt: "User profile",
				scope: "user",
			});

			handleAgentsProfileCommand(["delete", "api reviewer", "--scope", "user"]);

			expect(existsSync(getSpecialistProfilePath("api reviewer", "user"))).toBe(
				false,
			);
			expect(
				existsSync(getSpecialistProfilePath("api reviewer", "project")),
			).toBe(true);
		} finally {
			process.chdir(originalCwd);
		}
	});

	it("rejects invalid profile delete scopes", () => {
		expect(() =>
			handleAgentsProfileCommand(["delete", "api reviewer", "--scope", "team"]),
		).toThrow("invalid profile scope: team");
	});
});
