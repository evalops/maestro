import type {
	ComposerPendingClientToolRequest,
	ComposerToolRetryRequest,
} from "@evalops/contracts";
import type { ApiClient, Session } from "../services/api-client.js";

type ToastType = "success" | "error" | "info";

type ComposerChatClientRequestsApi = Pick<
	ApiClient,
	"sendClientToolResult" | "submitToolRetryDecision"
>;

export type ComposerChatClientRequestState = {
	pendingToolRetryQueue: ComposerToolRetryRequest[];
	toolRetrySubmitting: boolean;
	pendingMcpElicitationQueue: ComposerPendingClientToolRequest[];
	mcpElicitationSubmitting: boolean;
	pendingUserInputQueue: ComposerPendingClientToolRequest[];
	userInputSubmitting: boolean;
};

function isUserInputRequest(
	request: Pick<ComposerPendingClientToolRequest, "kind" | "toolName">,
): boolean {
	return request.kind === "user_input" || request.toolName === "ask_user";
}

function isMcpElicitationRequest(
	request: Pick<ComposerPendingClientToolRequest, "kind" | "toolName">,
): boolean {
	return (
		request.kind === "mcp_elicitation" || request.toolName === "mcp_elicitation"
	);
}

export class ComposerChatClientRequests {
	constructor(
		private readonly getApi: () => ComposerChatClientRequestsApi,
		private readonly getState: () => ComposerChatClientRequestState,
		private readonly setState: (
			state: Partial<ComposerChatClientRequestState>,
		) => void,
		private readonly showToast: (
			message: string,
			type: ToastType,
			duration?: number,
		) => void,
	) {}

	enqueueToolRetryRequest(request: ComposerToolRetryRequest) {
		if (
			this.getState().pendingToolRetryQueue.some(
				(entry) => entry.id === request.id,
			)
		) {
			return;
		}
		this.setState({
			pendingToolRetryQueue: [
				...this.getState().pendingToolRetryQueue,
				request,
			],
		});
	}

	clearToolRetryRequest(requestId: string) {
		this.setState({
			pendingToolRetryQueue: this.getState().pendingToolRetryQueue.filter(
				(request) => request.id !== requestId,
			),
		});
	}

	enqueueMcpElicitationRequest(request: ComposerPendingClientToolRequest) {
		const existingIndex = this.getState().pendingMcpElicitationQueue.findIndex(
			(entry) => entry.toolCallId === request.toolCallId,
		);
		if (existingIndex < 0) {
			this.setState({
				pendingMcpElicitationQueue: [
					...this.getState().pendingMcpElicitationQueue,
					request,
				],
			});
			return;
		}
		const nextQueue = [...this.getState().pendingMcpElicitationQueue];
		nextQueue[existingIndex] = request;
		this.setState({
			pendingMcpElicitationQueue: nextQueue,
		});
	}

	clearMcpElicitationRequest(toolCallId: string) {
		this.setState({
			pendingMcpElicitationQueue:
				this.getState().pendingMcpElicitationQueue.filter(
					(request) => request.toolCallId !== toolCallId,
				),
		});
	}

	enqueueUserInputRequest(request: ComposerPendingClientToolRequest) {
		const existingIndex = this.getState().pendingUserInputQueue.findIndex(
			(entry) => entry.toolCallId === request.toolCallId,
		);
		if (existingIndex < 0) {
			this.setState({
				pendingUserInputQueue: [
					...this.getState().pendingUserInputQueue,
					request,
				],
			});
			return;
		}
		const nextQueue = [...this.getState().pendingUserInputQueue];
		nextQueue[existingIndex] = request;
		this.setState({
			pendingUserInputQueue: nextQueue,
		});
	}

	clearUserInputRequest(toolCallId: string) {
		this.setState({
			pendingUserInputQueue: this.getState().pendingUserInputQueue.filter(
				(request) => request.toolCallId !== toolCallId,
			),
		});
	}

	resetPendingRequests() {
		this.setState({
			pendingToolRetryQueue: [],
			toolRetrySubmitting: false,
			pendingMcpElicitationQueue: [],
			mcpElicitationSubmitting: false,
			pendingUserInputQueue: [],
			userInputSubmitting: false,
		});
	}

	restorePendingRequests(
		session: Pick<
			Session,
			"pendingToolRetryRequests" | "pendingClientToolRequests"
		>,
	): ComposerPendingClientToolRequest[] {
		const pendingClientToolRequests = Array.isArray(
			session.pendingClientToolRequests,
		)
			? [...session.pendingClientToolRequests]
			: [];
		this.setState({
			pendingToolRetryQueue: Array.isArray(session.pendingToolRetryRequests)
				? [...session.pendingToolRetryRequests]
				: [],
			toolRetrySubmitting: false,
			pendingMcpElicitationQueue: pendingClientToolRequests.filter(
				isMcpElicitationRequest,
			),
			mcpElicitationSubmitting: false,
			pendingUserInputQueue:
				pendingClientToolRequests.filter(isUserInputRequest),
			userInputSubmitting: false,
		});
		return pendingClientToolRequests.filter(
			(request) =>
				!isUserInputRequest(request) && !isMcpElicitationRequest(request),
		);
	}

	async submitToolRetryDecision(
		action: "retry" | "skip" | "abort",
		requestId?: string,
	) {
		if (!requestId || this.getState().toolRetrySubmitting) {
			return;
		}

		this.setState({ toolRetrySubmitting: true });

		try {
			await this.getApi().submitToolRetryDecision({ requestId, action });
			this.clearToolRetryRequest(requestId);
			this.showToast(
				action === "retry"
					? "Retry submitted"
					: action === "skip"
						? "Retry skipped"
						: "Retry aborted",
				action === "abort" ? "info" : "success",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit retry decision",
				"error",
				2200,
			);
		} finally {
			this.setState({ toolRetrySubmitting: false });
		}
	}

	async submitUserInputResponse(
		responseText?: string,
		toolCallId?: string,
		isError = false,
	) {
		const trimmedResponse = responseText?.trim();
		if (!toolCallId || this.getState().userInputSubmitting) {
			return;
		}
		if (!trimmedResponse) {
			this.showToast(
				"Select an option or enter a custom response",
				"info",
				1800,
			);
			return;
		}

		this.setState({ userInputSubmitting: true });

		try {
			await this.getApi().sendClientToolResult({
				toolCallId,
				content: [{ type: "text", text: trimmedResponse }],
				isError,
			});
			this.clearUserInputRequest(toolCallId);
			this.showToast(
				isError ? "Input request cancelled" : "Input submitted",
				isError ? "info" : "success",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit input response",
				"error",
				2200,
			);
		} finally {
			this.setState({ userInputSubmitting: false });
		}
	}

	async submitMcpElicitationResponse(
		toolCallId?: string,
		action: "accept" | "decline" | "cancel" = "cancel",
		content?: Record<string, string | number | boolean | string[]>,
	) {
		if (!toolCallId || this.getState().mcpElicitationSubmitting) {
			return;
		}

		this.setState({ mcpElicitationSubmitting: true });

		try {
			await this.getApi().sendClientToolResult({
				toolCallId,
				content: [
					{
						type: "text",
						text: JSON.stringify({
							action,
							...(action === "accept" && content ? { content } : {}),
						}),
					},
				],
				isError: false,
			});
			this.clearMcpElicitationRequest(toolCallId);
			this.showToast(
				action === "accept"
					? "MCP input submitted"
					: action === "decline"
						? "MCP request declined"
						: "MCP request cancelled",
				action === "accept" ? "success" : "info",
				1500,
			);
		} catch (error) {
			this.showToast(
				error instanceof Error
					? error.message
					: "Failed to submit MCP response",
				"error",
				2200,
			);
		} finally {
			this.setState({ mcpElicitationSubmitting: false });
		}
	}
}
