import { describe, expect, it } from "vitest";
import { WelcomeAnimation } from "../../src/cli-tui/welcome-animation.js";

describe("WelcomeAnimation", () => {
	it("renders a plain Maestro start screen without legacy wordmark copy", () => {
		const animation = new WelcomeAnimation(undefined, { animate: false });
		const output = animation.render(80).join("\n");

		expect(output).toContain("Maestro");
		expect(output).not.toContain("composer");
		expect(output).not.toContain("deterministic coding agent");
	});

	it("renders project onboarding guidance when setup is incomplete", () => {
		const animation = new WelcomeAnimation(undefined, { animate: false });
		animation.setProjectOnboarding({
			shouldShow: true,
			completed: false,
			seenCount: 0,
			steps: [
				{
					key: "workspace",
					text: "Ask Maestro to create a new app or clone a repository.",
					isComplete: true,
					isEnabled: false,
				},
				{
					key: "instructions",
					text: "Run /init to scaffold AGENTS.md instructions for this project.",
					isComplete: false,
					isEnabled: true,
				},
			],
		});

		const output = animation.render(80).join("\n");

		expect(output).toContain("Get Started");
		expect(output).toContain("/init");
		expect(output).toContain("AGENTS.md");
		expect(output).toContain("Run /init");
	});
});
