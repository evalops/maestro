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

type RuntimeStatusInternals = {
	apiClient: {
		createSession: ReturnType<typeof vi.fn>;
		getSession: ReturnType<typeof vi.fn>;
	};
	runtimeStatus: string | null;
	refreshUiState: ReturnType<typeof vi.fn>;
	loadSessions: ReturnType<typeof vi.fn>;
	requestUpdate: ReturnType<typeof vi.fn>;
	updateComplete: Promise<void>;
	scrollToBottom: ReturnType<typeof vi.fn>;
	createNewSession: () => Promise<void>;
	selectSession: (sessionId: string) => Promise<void>;
};

function createChat() {
	const element = new ComposerChat() as unknown as RuntimeStatusInternals;
	element.refreshUiState = vi.fn().mockResolvedValue(undefined);
	element.loadSessions = vi.fn().mockResolvedValue(undefined);
	element.requestUpdate = vi.fn();
	element.scrollToBottom = vi.fn();
	Object.defineProperty(element, "updateComplete", {
		configurable: true,
		value: Promise.resolve(),
	});
	return element;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("composer-chat runtime status", () => {
	it("clears runtime status immediately when creating a new session", async () => {
		const pendingSession = createDeferred<{
			id: string;
			messages: unknown[];
		}>();
		const element = createChat();
		element.apiClient = {
			createSession: vi.fn().mockReturnValue(pendingSession.promise),
			getSession: vi.fn(),
		};
		element.runtimeStatus = "Compacting conversation...";

		const createPromise = element.createNewSession();

		expect(element.runtimeStatus).toBeNull();

		pendingSession.resolve({
			id: "session-2",
			messages: [],
		});
		await createPromise;
	});

	it("clears runtime status immediately when selecting another session", async () => {
		const pendingSession = createDeferred<{
			id: string;
			messages: unknown[];
		}>();
		const element = createChat();
		element.apiClient = {
			createSession: vi.fn(),
			getSession: vi.fn().mockReturnValue(pendingSession.promise),
		};
		element.runtimeStatus = "Compacting conversation...";

		const selectPromise = element.selectSession("session-2");

		expect(element.runtimeStatus).toBeNull();

		pendingSession.resolve({
			id: "session-2",
			messages: [],
		});
		await selectPromise;
	});
});
