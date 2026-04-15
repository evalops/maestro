import { fixture, html } from "@open-wc/testing";
import { LitElement } from "lit";
import { assert, describe, it } from "vitest";
import type {
	SessionSummary,
	WorkspaceStatus,
} from "../services/api-client.js";
import "./composer-message.js";
import {
	buildComposerChatViewport,
	renderComposerChatMessagePane,
} from "./composer-chat-message-pane.js";
import type { UiMessage } from "./composer-chat-stream-state.js";

class TestComposerChatMessagePaneHost extends LitElement {
	messages: UiMessage[] = [];
	loading = false;
	loadingEarlier = false;
	unseenMessages = 0;
	compactMode = false;
	cleanMode: "off" | "soft" | "aggressive" = "off";
	reducedMotion = false;
	isShared = false;
	cwd = "/repo/project";
	gitBranch = "main";
	gitSummary = "clean";
	currentModel = "anthropic/claude-sonnet-4-5";
	currentModelTokens: string | null = "200k";
	currentSessionId: string | null = null;
	totalCost: string | null = null;
	status: WorkspaceStatus | null = null;
	sessions: SessionSummary[] = [];
	windowStart = 0;
	windowEnd = 0;
	virtualStartIndex = 0;
	virtualEndIndex = 0;
	virtualPaddingTop = 0;
	virtualPaddingBottom = 0;
	virtualizationMinMessages = 120;
	entryActions: string[] = [];
	selectedSessions: string[] = [];
	loadEarlierCalls = 0;
	jumpCalls = 0;

	override render() {
		return renderComposerChatMessagePane({
			messages: this.messages,
			loading: this.loading,
			loadingEarlier: this.loadingEarlier,
			unseenMessages: this.unseenMessages,
			compactMode: this.compactMode,
			cleanMode: this.cleanMode,
			reducedMotion: this.reducedMotion,
			isShared: this.isShared,
			cwd: this.cwd,
			gitBranch: this.gitBranch,
			gitSummary: this.gitSummary,
			currentModel: this.currentModel,
			currentModelTokens: this.currentModelTokens,
			currentSessionId: this.currentSessionId,
			totalCost: this.totalCost,
			status: this.status,
			sessions: this.sessions,
			viewport: buildComposerChatViewport(this.messages, {
				windowStart: this.windowStart,
				windowEnd: this.windowEnd,
				virtualStartIndex: this.virtualStartIndex,
				virtualEndIndex: this.virtualEndIndex,
				virtualPaddingTop: this.virtualPaddingTop,
				virtualPaddingBottom: this.virtualPaddingBottom,
				virtualizationMinMessages: this.virtualizationMinMessages,
			}),
			onSubmitEntryAction: (value) => {
				this.entryActions.push(value);
			},
			onSelectSession: (sessionId) => {
				this.selectedSessions.push(sessionId);
			},
			onLoadEarlierMessages: () => {
				this.loadEarlierCalls += 1;
			},
			onJumpToLatest: () => {
				this.jumpCalls += 1;
			},
		});
	}
}

if (!customElements.get("test-composer-chat-message-pane-host")) {
	customElements.define(
		"test-composer-chat-message-pane-host",
		TestComposerChatMessagePaneHost,
	);
}

describe("composer chat message pane", () => {
	it("builds a virtualized viewport with hidden counts", () => {
		const messages = Array.from({ length: 150 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: `message-${index}`,
		})) as UiMessage[];

		const viewport = buildComposerChatViewport(messages, {
			windowStart: 20,
			windowEnd: 140,
			virtualStartIndex: 30,
			virtualEndIndex: 50,
			virtualPaddingTop: 120,
			virtualPaddingBottom: 80,
			virtualizationMinMessages: 120,
		});

		assert.equal(viewport.totalMessages, 150);
		assert.equal(viewport.hiddenOldCount, 20);
		assert.equal(viewport.hiddenNewCount, 10);
		assert.equal(viewport.visibleCount, 120);
		assert.equal(viewport.renderedStartIndex, 30);
		assert.equal(viewport.renderedMessages.length, 20);
		assert.equal(viewport.topSpacerHeight, 120);
		assert.equal(viewport.bottomSpacerHeight, 80);
		assert.equal(viewport.renderedMessages[0]?.content, "message-30");
	});

	it("renders onboarding actions and resumable sessions in the empty state", async () => {
		const element = await fixture<TestComposerChatMessagePaneHost>(
			html`<test-composer-chat-message-pane-host></test-composer-chat-message-pane-host>`,
		);
		element.status = {
			onboarding: {
				steps: [
					{
						key: "instructions",
						text: "Add project instructions",
						isComplete: false,
						isEnabled: true,
					},
				],
			},
		} as WorkspaceStatus;
		element.sessions = [
			{
				id: "session-12345678",
				title: "Resume me",
				updatedAt: new Date().toISOString(),
				messageCount: 12,
				resumeSummary: "Follow up on the retryable tool call handling",
			} as SessionSummary,
		];
		element.windowEnd = 0;
		element.requestUpdate();
		await element.updateComplete;

		const onboardingButton = element.shadowRoot?.querySelector(
			".onboarding-action.command",
		) as HTMLButtonElement | null;
		const sessionCard = element.shadowRoot?.querySelector(
			".session-card",
		) as HTMLButtonElement | null;

		assert.ok(onboardingButton);
		assert.ok(sessionCard);
		assert.include(element.shadowRoot?.textContent || "", "Getting Started");
		assert.include(element.shadowRoot?.textContent || "", "Resume a Session");

		onboardingButton.click();
		sessionCard.click();
		await element.updateComplete;

		assert.equal(element.entryActions.length, 1);
		assert.equal(element.selectedSessions[0], "session-12345678");
	});

	it("renders history controls and visible messages for populated sessions", async () => {
		const element = await fixture<TestComposerChatMessagePaneHost>(
			html`<test-composer-chat-message-pane-host></test-composer-chat-message-pane-host>`,
		);
		element.messages = [
			{ role: "user", content: "first" },
			{ role: "assistant", content: "second" },
			{ role: "assistant", content: "third" },
		] as UiMessage[];
		element.windowStart = 1;
		element.windowEnd = 3;
		element.unseenMessages = 2;
		element.requestUpdate();
		await element.updateComplete;

		const loadEarlierButton = element.shadowRoot?.querySelector(
			".history-btn",
		) as HTMLButtonElement | null;
		const jumpButton = element.shadowRoot?.querySelector(
			".jump-latest",
		) as HTMLButtonElement | null;
		const renderedMessages =
			element.shadowRoot?.querySelectorAll("composer-message") ?? [];
		const normalizedText = (element.shadowRoot?.textContent || "").replace(
			/\s+/g,
			" ",
		);

		assert.ok(loadEarlierButton);
		assert.ok(jumpButton);
		assert.equal(renderedMessages.length, 2);
		assert.include(normalizedText, "Showing 2 of 3");

		loadEarlierButton.click();
		jumpButton.click();

		assert.equal(element.loadEarlierCalls, 1);
		assert.equal(element.jumpCalls, 1);
	});
});
