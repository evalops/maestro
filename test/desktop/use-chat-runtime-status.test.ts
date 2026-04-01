// @vitest-environment happy-dom
import { createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../../packages/desktop/src/renderer/hooks/useChat";
import { apiClient } from "../../packages/desktop/src/renderer/lib/api-client";
import type { Message } from "../../packages/desktop/src/renderer/lib/types";

type HookSnapshot = {
	messages: Message[];
	runtimeStatus: string | null;
};

function createDeferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

async function flushAsyncWork(iterations = 4) {
	for (let index = 0; index < iterations; index++) {
		await Promise.resolve();
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

function Harness(props: {
	sessionId?: string;
	onRender: (snapshot: HookSnapshot) => void;
	onReady: (send: (content: string) => Promise<void>) => void;
}) {
	const chat = useChat(props.sessionId);
	props.onRender({
		messages: chat.messages,
		runtimeStatus: chat.runtimeStatus,
	});
	props.onReady(chat.sendMessage);
	return null;
}

describe("useChat runtime status", () => {
	let container: HTMLDivElement | undefined;
	let root: Root | undefined;

	afterEach(async () => {
		if (root) {
			await act(async () => {
				root?.unmount();
				await flushAsyncWork(1);
			});
		}
		container?.remove();
		container = undefined;
		root = undefined;
		vi.restoreAllMocks();
	});

	it("clears runtime status immediately when switching sessions", async () => {
		const firstSessionLoaded = createDeferred<void>();
		const secondSessionLoaded = createDeferred<void>();
		const streamReleased = createDeferred<void>();
		let latestSnapshot: HookSnapshot = { messages: [], runtimeStatus: null };
		let sendMessage: ((content: string) => Promise<void>) | undefined;

		vi.spyOn(apiClient, "getSession")
			.mockImplementationOnce(async () => {
				await firstSessionLoaded.promise;
				return {
					id: "session-1",
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					messageCount: 1,
					messages: [],
				};
			})
			.mockImplementationOnce(async () => {
				await secondSessionLoaded.promise;
				return {
					id: "session-2",
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					messageCount: 1,
					messages: [],
				};
			});
		vi.spyOn(apiClient, "chat").mockReturnValue(
			(async function* () {
				yield { type: "status", status: "compacting", details: {} };
				await streamReleased.promise;
				yield { type: "done" };
			})(),
		);

		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);

		await act(async () => {
			root?.render(
				createElement(Harness, {
					sessionId: "session-1",
					onRender: (snapshot: HookSnapshot) => {
						latestSnapshot = snapshot;
					},
					onReady: (send: (content: string) => Promise<void>) => {
						sendMessage = send;
					},
				}),
			);
			await flushAsyncWork(1);
		});

		expect(sendMessage).toBeTypeOf("function");
		const pendingSend = sendMessage?.("Hello");
		await act(async () => {
			await flushAsyncWork(2);
		});
		expect(latestSnapshot.runtimeStatus).toBe("Compacting conversation...");

		await act(async () => {
			root?.render(
				createElement(Harness, {
					sessionId: "session-2",
					onRender: (snapshot: HookSnapshot) => {
						latestSnapshot = snapshot;
					},
					onReady: (send: (content: string) => Promise<void>) => {
						sendMessage = send;
					},
				}),
			);
			await flushAsyncWork(1);
		});
		expect(latestSnapshot.runtimeStatus).toBeNull();

		streamReleased.resolve();
		firstSessionLoaded.resolve();
		secondSessionLoaded.resolve();
		await pendingSend;
	});
});
