import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	applySpecialistProfileToPrompt,
	createSpecialistProfile,
	getSpecialistProfileDir,
	listSpecialistProfiles,
	normalizeSpecialistProfileName,
	resolveSpecialistProfile,
} from "../../src/agent/specialist-profiles.js";

describe("agent/specialist-profiles", () => {
	it("loads project profiles ahead of user profiles", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-profiles-work-"));
		const homeDir = mkdtempSync(join(tmpdir(), "maestro-profiles-home-"));
		const priorHome = process.env.MAESTRO_HOME;
		process.env.MAESTRO_HOME = homeDir;
		try {
			createSpecialistProfile({
				name: "rails-reviewer",
				prompt: "Use generic Rails review guidance.",
				scope: "user",
				workspaceDir,
			});
			createSpecialistProfile({
				name: "rails-reviewer",
				description: "Project Rails reviewer",
				prompt: "Use project-specific Rails boundaries.",
				scope: "project",
				workspaceDir,
			});

			const resolved = resolveSpecialistProfile("rails reviewer", workspaceDir);
			expect(resolved).toMatchObject({
				scope: "project",
				description: "Project Rails reviewer",
			});
			expect(listSpecialistProfiles(workspaceDir)).toHaveLength(1);
		} finally {
			if (priorHome === undefined) {
				delete process.env.MAESTRO_HOME;
			} else {
				process.env.MAESTRO_HOME = priorHome;
			}
		}
	});

	it("skips malformed profiles while listing and resolving valid profiles", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "maestro-profiles-work-"));
		createSpecialistProfile({
			name: "valid-reviewer",
			prompt: "Use valid reviewer guidance.",
			scope: "project",
			workspaceDir,
		});
		const profileDir = getSpecialistProfileDir("project", workspaceDir);
		mkdirSync(profileDir, { recursive: true });
		writeFileSync(
			join(profileDir, "bad.md"),
			'---\nname: "unterminated\n---\nBad profile\n',
		);

		expect(
			listSpecialistProfiles(workspaceDir).map((profile) => profile.name),
		).toEqual(["valid-reviewer"]);
		expect(
			resolveSpecialistProfile("valid reviewer", workspaceDir),
		).toMatchObject({ name: "valid-reviewer" });
	});

	it("prepends profile instructions to delegated prompts", () => {
		const prompt = applySpecialistProfileToPrompt("Fix checkout", {
			name: "payments",
			description: "Payments specialist",
			prompt: "Respect PCI boundaries.",
			scope: "project",
			path: "/repo/.maestro/agent-profiles/payments.md",
		});

		expect(prompt).toContain("Specialist profile: payments");
		expect(prompt).toContain("Respect PCI boundaries.");
		expect(prompt).toContain("Assigned task:\nFix checkout");
	});

	it("rejects names that normalize to empty", () => {
		expect(() => normalizeSpecialistProfileName("!!!")).toThrow("profile name");
		expect(() => normalizeSpecialistProfileName("---")).toThrow("profile name");
	});
});
