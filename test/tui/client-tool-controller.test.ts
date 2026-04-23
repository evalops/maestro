import type { Container, TUI } from "@evalops/tui";
import { describe, expect, it, vi } from "vitest";
import { ClientToolController } from "../../src/cli-tui/client-tools/client-tool-controller.js";
import { TuiClientToolService } from "../../src/cli-tui/client-tools/local-client-tool-service.js";
import type { HookInputModalOptions } from "../../src/cli-tui/hooks/hook-input-modal.js";
import type { Modal } from "../../src/cli-tui/modal-manager.js";

class FakeModal implements Modal {
	constructor(readonly options: HookInputModalOptions) {}

	render(): string[] {
		return [];
	}
}

function createHarness() {
	const service = new TuiClientToolService();
	const ui = {
		setFocus: vi.fn(),
		requestRender: vi.fn(),
	} as unknown as TUI;
	const editor = { render: () => [] } as never;
	let currentModal: FakeModal | null = null;
	const editorContainer = {
		clear: vi.fn(),
		addChild: vi.fn((child: unknown) => {
			currentModal = child instanceof FakeModal ? child : null;
		}),
	} as unknown as Container;
	const notificationView = {
		showError: vi.fn(),
		showInfo: vi.fn(),
		showToast: vi.fn(),
	} as never;
	const openUrl = vi.fn().mockResolvedValue(true);
	const onPendingStatusChange = vi.fn();

	new ClientToolController({
		clientToolService: service,
		ui,
		editor,
		editorContainer,
		notificationView,
		createInputModal: (options) => new FakeModal(options),
		openUrl,
		onPendingStatusChange,
	});

	const getModal = () => {
		expect(currentModal).not.toBeNull();
		return currentModal as FakeModal;
	};

	return {
		service,
		editorContainer,
		getModal,
		notificationView,
		onPendingStatusChange,
		openUrl,
	};
}

function getTextResult(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	const block = result.content[0];
	expect(block?.type).toBe("text");
	return block?.text ?? "";
}

describe("ClientToolController", () => {
	it("collects multi-step ask_user answers in the TUI flow", async () => {
		const harness = createHarness();

		const resultPromise = harness.service.requestExecution(
			"ask-1",
			"ask_user",
			{
				questions: [
					{
						header: "Stack",
						question: "Which stack should we use?",
						options: [
							{
								label: "React",
								description: "Use React for the frontend.",
								preview: {
									kind: "markdown",
									title: "React empty state",
									body: "### No runs yet\nStart a run to see traces here.",
								},
							},
							{
								label: "Vue",
								description: "Use Vue for the frontend.",
							},
						],
					},
					{
						header: "Tests",
						question: "What test runner should we use?",
						options: [
							{
								label: "Vitest",
								description: "Use Vitest for unit tests.",
							},
							{
								label: "Jest",
								description: "Use Jest for unit tests.",
							},
						],
					},
				],
			},
		);

		await Promise.resolve();
		expect(harness.getModal().options.description).toContain("Which stack");
		expect(harness.getModal().options.description).toContain(
			"Preview (markdown: React empty state)",
		);
		expect(harness.getModal().options.description).toContain("### No runs yet");
		harness.getModal().options.onSubmit("1");

		await Promise.resolve();
		expect(harness.getModal().options.description).toContain(
			"What test runner",
		);
		harness.getModal().options.onSubmit("Vitest");

		const result = await resultPromise;
		expect(result.isError).toBe(false);
		expect(getTextResult(result)).toBe("Stack: React\nTests: Vitest");
		expect(harness.onPendingStatusChange).toHaveBeenNthCalledWith(
			1,
			"ask-1",
			"Waiting for structured input",
		);
		expect(harness.onPendingStatusChange).toHaveBeenLastCalledWith(
			"ask-1",
			null,
		);
	});

	it("cancels ask_user requests with the same error payload as the web client", async () => {
		const harness = createHarness();

		const resultPromise = harness.service.requestExecution(
			"ask-2",
			"ask_user",
			{
				questions: [
					{
						header: "Plan",
						question: "Which plan should we follow?",
						options: [
							{
								label: "Small",
								description: "Keep the change small.",
							},
							{
								label: "Large",
								description: "Take the larger refactor.",
							},
						],
					},
				],
			},
		);

		await Promise.resolve();
		harness.getModal().options.onCancel();

		const result = await resultPromise;
		expect(result.isError).toBe(true);
		expect(getTextResult(result)).toBe(
			"User cancelled structured input request.",
		);
	});

	it("collects MCP elicitation form values and returns the accept payload", async () => {
		const harness = createHarness();

		const resultPromise = harness.service.requestExecution(
			"mcp-1",
			"mcp_elicitation",
			{
				serverName: "registry",
				requestId: "req-1",
				mode: "form",
				message: "Need deployment inputs.",
				requestedSchema: {
					type: "object",
					properties: {
						environment: {
							type: "string",
							title: "Environment",
							enum: ["prod", "staging"],
							enumNames: ["Production", "Staging"],
						},
						replicas: {
							type: "integer",
							title: "Replicas",
							minimum: 1,
						},
					},
					required: ["environment", "replicas"],
				},
			},
		);

		await Promise.resolve();
		expect(harness.getModal().options.description).toContain("Production");
		harness.getModal().options.onSubmit("1");

		await Promise.resolve();
		expect(harness.getModal().options.description).toContain("Replicas");
		harness.getModal().options.onSubmit("2");

		const result = await resultPromise;
		expect(result.isError).toBe(false);
		expect(JSON.parse(getTextResult(result))).toEqual({
			action: "accept",
			content: {
				environment: "prod",
				replicas: 2,
			},
		});
		expect(harness.onPendingStatusChange).toHaveBeenNthCalledWith(
			1,
			"mcp-1",
			"Waiting for MCP input",
		);
		expect(harness.onPendingStatusChange).toHaveBeenLastCalledWith(
			"mcp-1",
			null,
		);
	});

	it("opens MCP URL requests and supports decline responses", async () => {
		const harness = createHarness();

		const resultPromise = harness.service.requestExecution(
			"mcp-2",
			"mcp_elicitation",
			{
				serverName: "oauth",
				requestId: "req-2",
				mode: "url",
				message: "Finish authentication in your browser.",
				url: "https://example.com/authorize",
			},
		);

		await Promise.resolve();
		expect(harness.openUrl).toHaveBeenCalledWith(
			"https://example.com/authorize",
		);
		harness.getModal().options.onSubmit("decline");

		const result = await resultPromise;
		expect(result.isError).toBe(false);
		expect(JSON.parse(getTextResult(result))).toEqual({
			action: "decline",
		});
	});
});
