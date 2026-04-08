// @vitest-environment happy-dom
import { render } from "lit";
import { describe, expect, it } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

type ComposerChatOnboardingInternals = ComposerChat & {
	status: {
		cwd: string;
		git: null;
		context: { agentMd: boolean; claudeMd: boolean };
		onboarding: {
			shouldShow: boolean;
			completed: boolean;
			seenCount: number;
			steps: Array<{
				key: "workspace" | "instructions";
				text: string;
				isComplete: boolean;
				isEnabled: boolean;
			}>;
		};
		server: { uptime: number; version: string };
		database: { configured: boolean; connected: boolean };
		backgroundTasks: null;
		hooks: {
			asyncInFlight: number;
			concurrency: { max: number; active: number; queued: number };
		};
		lastUpdated: number;
		lastLatencyMs: number;
	} | null;
	messages: unknown[];
	sessions: unknown[];
	currentSessionId: string | null;
	currentModel: string;
	currentModelTokens: string | null;
	clientOnline: boolean;
	shareToken: string | null;
	usage: null;
	runtimeStatus: string | null;
	error: string | null;
	render: () => unknown;
};

describe("composer-chat onboarding empty state", () => {
	it("renders onboarding guidance when project setup is incomplete", () => {
		const element = new ComposerChat() as ComposerChatOnboardingInternals;
		element.status = {
			cwd: "/repo",
			git: null,
			context: { agentMd: false, claudeMd: false },
			onboarding: {
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
			},
			server: { uptime: 60, version: "v20.0.0" },
			database: { configured: false, connected: false },
			backgroundTasks: null,
			hooks: {
				asyncInFlight: 0,
				concurrency: { max: 0, active: 0, queued: 0 },
			},
			lastUpdated: Date.now(),
			lastLatencyMs: 5,
		};
		element.messages = [];
		element.sessions = [];
		element.currentSessionId = null;
		element.currentModel = "anthropic/claude-sonnet-4-5";
		element.currentModelTokens = "200k ctx";
		element.clientOnline = true;
		element.shareToken = null;
		element.usage = null;
		element.runtimeStatus = null;
		element.error = null;

		const container = document.createElement("div");
		render(element.render() as Parameters<typeof render>[0], container);

		expect(container.textContent ?? "").toContain("Getting Started");
		expect(container.textContent ?? "").toContain(
			"Run /init to scaffold AGENTS.md instructions for this project.",
		);
	});
});
