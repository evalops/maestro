// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerChat } from "../../packages/web/src/components/composer-chat.js";

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

type ApprovalStatusInternals = {
	apiClient: {
		getApprovalMode: ReturnType<typeof vi.fn>;
	};
	currentSessionId: string | null;
	shareToken: string | null;
	approvalMode: "auto" | "prompt" | "fail" | null;
	approvalModeNotice: string | null;
	loadApprovalModeStatus: (sessionId?: string) => Promise<void>;
	refreshUiState: ReturnType<typeof vi.fn>;
	showToast: ReturnType<typeof vi.fn>;
	updated: (changed: Map<PropertyKey, unknown>) => void;
	updateApprovalModeStatus: (options: {
		mode: "auto" | "prompt" | "fail";
		message?: string;
		notify?: boolean;
		sessionId?: string | null;
	}) => void;
};

describe("ComposerChat approval status", () => {
	it("loads the current approval mode for the active session", async () => {
		const element = new ComposerChat() as unknown as ApprovalStatusInternals;
		element.apiClient = {
			getApprovalMode: vi.fn().mockResolvedValue({
				mode: "prompt",
				availableModes: ["auto", "prompt", "fail"],
			}),
		};
		element.currentSessionId = "session-1";
		element.shareToken = null;

		await element.loadApprovalModeStatus();

		expect(element.apiClient.getApprovalMode).toHaveBeenCalledWith("session-1");
		expect(element.approvalMode).toBe("prompt");
	});

	it("stores stricter-server notices when approval mode resolves down", () => {
		const element = new ComposerChat() as unknown as ApprovalStatusInternals;
		element.currentSessionId = "session-1";
		element.showToast = vi.fn();

		element.updateApprovalModeStatus({
			mode: "fail",
			message:
				"Approval mode resolved to fail because the server default is stricter",
			notify: true,
			sessionId: "session-1",
		});

		expect(element.approvalMode).toBe("fail");
		expect(element.approvalModeNotice).toContain("server default is stricter");
		expect(element.showToast).toHaveBeenCalledWith(
			"Approval mode resolved to fail because the server default is stricter",
			"info",
			2200,
		);
	});

	it("ignores stale approval mode responses after the active session changes", async () => {
		const first = createDeferred<{
			mode: "auto" | "prompt" | "fail";
			availableModes: Array<"auto" | "prompt" | "fail">;
		}>();
		const second = createDeferred<{
			mode: "auto" | "prompt" | "fail";
			availableModes: Array<"auto" | "prompt" | "fail">;
		}>();
		const element = new ComposerChat() as unknown as ApprovalStatusInternals;
		element.apiClient = {
			getApprovalMode: vi
				.fn()
				.mockImplementationOnce(() => first.promise)
				.mockImplementationOnce(() => second.promise),
		};
		element.shareToken = null;

		element.currentSessionId = "session-1";
		const firstLoad = element.loadApprovalModeStatus("session-1");

		element.currentSessionId = "session-2";
		const secondLoad = element.loadApprovalModeStatus("session-2");

		second.resolve({
			mode: "fail",
			availableModes: ["auto", "prompt", "fail"],
		});
		await secondLoad;

		first.resolve({
			mode: "auto",
			availableModes: ["auto", "prompt", "fail"],
		});
		await firstLoad;

		expect(element.approvalMode).toBe("fail");
	});

	it("clears the approval mode immediately when switching sessions", async () => {
		const element = new ComposerChat() as unknown as ApprovalStatusInternals;
		element.apiClient = {
			getApprovalMode: vi.fn().mockResolvedValue({
				mode: "fail",
				availableModes: ["auto", "prompt", "fail"],
			}),
		};
		element.refreshUiState = vi.fn();
		element.shareToken = null;
		element.approvalMode = "prompt";
		element.currentSessionId = "session-2";
		element.updated(new Map([["currentSessionId", "session-1"]]));

		expect(element.approvalMode).toBeNull();
		expect(element.apiClient.getApprovalMode).toHaveBeenLastCalledWith(
			"session-2",
		);
	});

	it("clears the approval mode when loading the active session status fails", async () => {
		const element = new ComposerChat() as unknown as ApprovalStatusInternals;
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		element.apiClient = {
			getApprovalMode: vi.fn().mockRejectedValue(new Error("request failed")),
		};
		element.currentSessionId = "session-1";
		element.shareToken = null;
		element.approvalMode = "prompt";
		element.approvalModeNotice = "stale";

		await element.loadApprovalModeStatus();

		expect(element.approvalMode).toBeNull();
		expect(element.approvalModeNotice).toBeNull();
		expect(warnSpy).toHaveBeenCalled();
	});
});
