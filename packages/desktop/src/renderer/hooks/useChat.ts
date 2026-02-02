/**
 * useChat Hook
 *
 * Manages chat state and streaming responses.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api-client";
import type { Message } from "../lib/types";

export interface UseChatOptions {
	sessionId?: string;
}

export interface UseChatReturn {
	messages: Message[];
	isLoading: boolean;
	error: string | null;
	sendMessage: (content: string) => Promise<void>;
	clearError: () => void;
	clearMessages: () => void;
}

export function useChat(sessionId?: string): UseChatReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	// Load session messages when sessionId changes
	useEffect(() => {
		if (!sessionId) {
			setMessages([]);
			return;
		}

		const loadSession = async () => {
			try {
				const session = await apiClient.getSession(sessionId);
				if (session?.messages) {
					setMessages(session.messages);
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
				let fullContent = "";
				for await (const event of apiClient.chat({
					sessionId,
					messages: [...messages, userMessage],
				})) {
					if (event.type === "done") break;

					if (event.type === "message_update" && event.assistantMessageEvent) {
						const msgEvent = event.assistantMessageEvent;
						if (msgEvent.type === "text_delta" && msgEvent.delta) {
							fullContent += msgEvent.delta;
							setMessages((prev) => {
								const updated = [...prev];
								const lastMsg = updated[updated.length - 1];
								if (lastMsg && lastMsg.role === "assistant") {
									lastMsg.content = fullContent;
								}
								return updated;
							});
						}
					}
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
				setIsLoading(false);
				abortControllerRef.current = null;
			}
		},
		[sessionId, messages, isLoading],
	);

	const clearError = useCallback(() => {
		setError(null);
	}, []);

	const clearMessages = useCallback(() => {
		setMessages([]);
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
		sendMessage,
		clearError,
		clearMessages,
	};
}
