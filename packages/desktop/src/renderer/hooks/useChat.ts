/**
 * useChat Hook
 *
 * Manages chat state and streaming responses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api-client";
import {
	applyAgentEventToMessage,
	createAssistantStreamingState,
	normalizeServerMessage,
} from "../lib/chat-message-state";
import { formatDesktopRuntimeStatus } from "../lib/runtime-status";
import type { Message, ThinkingLevel } from "../lib/types";

export interface UseChatOptions {
	sessionId?: string;
	thinkingLevel?: ThinkingLevel;
}

export interface UseChatReturn {
	messages: Message[];
	isLoading: boolean;
	error: string | null;
	runtimeStatus: string | null;
	sendMessage: (content: string) => Promise<void>;
	clearError: () => void;
	clearMessages: () => void;
}

export function useChat(
	sessionId?: string,
	options: UseChatOptions = {},
): UseChatReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [runtimeStatus, setRuntimeStatus] = useState<string | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	// Load session messages when sessionId changes
	useEffect(() => {
		setRuntimeStatus(null);
		if (!sessionId) {
			setMessages([]);
			return;
		}

		const loadSession = async () => {
			try {
				const session = await apiClient.getSession(sessionId);
				if (session?.messages) {
					setMessages(
						session.messages
							.map((message) => normalizeServerMessage(message))
							.filter((message): message is Message => message !== null),
					);
				}
			} catch (err) {
				console.error("Failed to load session:", err);
			}
		};

		loadSession();
	}, [sessionId]);

	const sendMessage = useCallback(
		async (content: string) => {
			if (!content.trim() || isLoading) return;

			const userMessage: Message = {
				id: crypto.randomUUID(),
				role: "user",
				content: content.trim(),
				timestamp: new Date().toISOString(),
			};

			setMessages((prev) => [...prev, userMessage]);
			setIsLoading(true);
			setError(null);
			setRuntimeStatus(null);

			// Create abort controller for this request
			abortControllerRef.current = new AbortController();

			try {
				// Add assistant message placeholder
				const assistantMessage: Message = {
					id: crypto.randomUUID(),
					role: "assistant",
					content: "",
					timestamp: new Date().toISOString(),
				};
				setMessages((prev) => [...prev, assistantMessage]);

				// Stream the response
				const streamingState = createAssistantStreamingState();
				const updateAssistantMessage = (update: (message: Message) => void) => {
					setMessages((prev) => {
						const updated = [...prev];
						const lastMsg = updated[updated.length - 1];
						if (lastMsg && lastMsg.role === "assistant") {
							update(lastMsg);
						}
						return updated;
					});
				};

				for await (const event of apiClient.chat({
					sessionId,
					messages: [...messages, userMessage],
					thinkingLevel: options.thinkingLevel,
				})) {
					const nextRuntimeStatus = formatDesktopRuntimeStatus(event);
					if (nextRuntimeStatus) {
						setRuntimeStatus(nextRuntimeStatus);
						continue;
					}
					if (event.type === "done") break;
					updateAssistantMessage((lastMsg) => {
						applyAgentEventToMessage(lastMsg, event, streamingState);
					});
				}
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					return;
				}
				const errorMessage =
					err instanceof Error ? err.message : "An error occurred";
				setError(errorMessage);
				// Remove the failed assistant message
				setMessages((prev) => prev.slice(0, -1));
			} finally {
				setRuntimeStatus(null);
				setIsLoading(false);
				abortControllerRef.current = null;
			}
		},
		[sessionId, messages, isLoading, options.thinkingLevel],
	);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	const clearMessages = useCallback(() => {
		setMessages([]);
		setRuntimeStatus(null);
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (abortControllerRef.current) {
				abortControllerRef.current.abort();
			}
		};
	}, []);

	return {
		messages,
		isLoading,
		error,
		runtimeStatus,
		sendMessage,
		clearError,
		clearMessages,
	};
}
