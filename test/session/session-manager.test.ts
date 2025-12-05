import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentState } from "../../src/agent/types.js";
import { SessionManager } from "../../src/session/manager.js";

// Helper to create a minimal agent state
function createMockState(): AgentState {
	return {
		queueMode: "all",
		messages: [],
		systemPrompt: "test system prompt",
		model: {
			provider: "anthropic",
			id: "claude-sonnet-4",
			contextWindow: 200000,
			name: "Claude Sonnet 4",
			api: "anthropic-messages",
			baseUrl: "https://api.anthropic.com/v1/messages",
			reasoning: false,
			input: ["text", "image"],
			cost: {
				input: 0.003,
				output: 0.015,
				cacheRead: 0.0003,
				cacheWrite: 0.00375,
			},
			maxTokens: 8192,
		},
		tools: [],
		thinkingLevel: "off",
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Map(),
	};
}

// Helper to create a user message
function createUserMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
}

// Helper to create an assistant message
function createAssistantMessage(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "stop" as const,
		timestamp: Date.now(),
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

describe("SessionManager - Deferred Session Creation", () => {
	let testDir: string;
	let originalEnv: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		// Save original state
		originalCwd = process.cwd();
		originalEnv = process.env.COMPOSER_AGENT_DIR;

		// Create temp test directory for sessions
		testDir = join(tmpdir(), `composer-sessions-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.COMPOSER_AGENT_DIR = testDir;

		// Change to test directory
		process.chdir(testDir);
	});

	describe("Session metadata", () => {
		it("derives summaries and toggles favorites", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage(
				"Deeply review the codebase to get an understanding",
			);
			state.messages.push(userMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			sessionManager.saveMessage(createAssistantMessage("ack"));

			const sessions = sessionManager.loadAllSessions();
			expect(sessions.length).toBe(1);
			expect(sessions[0].summary).toContain("Deeply review the codebase");
			expect(sessions[0].favorite).toBe(false);

			sessionManager.setSessionFavorite(sessions[0].path, true);
			const updated = sessionManager.loadAllSessions();
			expect(updated[0].favorite).toBe(true);
		});

		it("prefers custom summary metadata when provided", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage("Investigate tests");
			state.messages.push(userMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			sessionManager.saveSessionSummary("Custom curated summary");

			const sessions = sessionManager.loadAllSessions();
			expect(sessions[0].summary).toBe("Custom curated summary");
		});
	});

	describe("Session metadata cache", () => {
		it("restores thinking level, model, and metadata across reloads", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage("Track metadata changes");
			state.messages.push(userMessage);

			sessionManager.saveThinkingLevelChange("medium");
			sessionManager.saveModelChange("openai/gpt-4o", {
				provider: "openai",
				modelId: "gpt-4o",
				contextWindow: 128000,
			});

			sessionManager.startSession(state);
			sessionManager.saveModelChange("anthropic/claude-sonnet-4", {
				provider: "anthropic",
				modelId: "claude-sonnet-4",
				contextWindow: 200000,
			});
			sessionManager.saveThinkingLevelChange("high");
			await sessionManager.flush();

			const sessionPath = sessionManager.getSessionFile();
			expect(existsSync(sessionPath)).toBe(true);

			const reloaded = new SessionManager(false, sessionPath);
			expect(reloaded.loadThinkingLevel()).toBe("high");
			expect(reloaded.loadModel()).toBe("anthropic/claude-sonnet-4");
			expect(reloaded.loadModelMetadata()).toEqual(
				expect.objectContaining({
					provider: "anthropic",
					modelId: "claude-sonnet-4",
					contextWindow: 200000,
				}),
			);
		});
	});

	afterEach(() => {
		// Restore original state
		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			// biome-ignore lint/performance/noDelete: Must use delete, not = undefined
			delete process.env.COMPOSER_AGENT_DIR;
		} else {
			process.env.COMPOSER_AGENT_DIR = originalEnv;
		}

		// Cleanup test directory
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true });
		}
	});

	describe("Session File Creation Timing", () => {
		it("should NOT create session file immediately on construction", () => {
			const sessionManager = new SessionManager(false);
			const sessionFile = sessionManager.getSessionFile();

			// Session file should not exist yet
			expect(existsSync(sessionFile)).toBe(false);

			// Session directory should exist though
			const sessionsDir = join(testDir, "sessions");
			expect(existsSync(sessionsDir)).toBe(true);
		});

		it("should NOT create session file when saving messages before startSession", () => {
			const sessionManager = new SessionManager(false);
			const sessionFile = sessionManager.getSessionFile();

			// Save a message before startSession
			const userMsg = createUserMessage("Hello");
			sessionManager.saveMessage(userMsg);

			// File should still not exist
			expect(existsSync(sessionFile)).toBe(false);
		});

		it("should create session file ONLY after startSession is called", () => {
			const sessionManager = new SessionManager(false);
			const sessionFile = sessionManager.getSessionFile();
			const state = createMockState();

			// Add a user message
			state.messages.push(createUserMessage("Hello"));
			sessionManager.saveMessage(state.messages[0]);

			// Still no file
			expect(existsSync(sessionFile)).toBe(false);

			// Now start the session (typically after first assistant response)
			sessionManager.startSession(state);

			// File should now exist
			expect(existsSync(sessionFile)).toBe(true);
		});

		it("should flush pending messages when session is started", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();

			// Queue multiple messages before session starts
			const msg1 = createUserMessage("First message");
			const msg2 = createAssistantMessage("First response");
			const msg3 = createUserMessage("Second message");

			sessionManager.saveMessage(msg1);
			sessionManager.saveMessage(msg2);
			sessionManager.saveMessage(msg3);

			// Start session - should flush all pending messages
			state.messages.push(msg1, msg2, msg3);
			sessionManager.startSession(state);

			// Load messages back
			const loadedMessages = sessionManager.loadMessages();

			// Should have all 3 messages
			expect(loadedMessages.length).toBe(3);
		});

		it("should prevent creating empty session files", () => {
			const sessionManager = new SessionManager(false);
			const sessionFile = sessionManager.getSessionFile();
			const sessionsDir = join(testDir, "sessions");

			// Don't call startSession at all

			// Session file should not exist
			expect(existsSync(sessionFile)).toBe(false);

			// Sessions directory should not have any .jsonl files
			if (existsSync(sessionsDir)) {
				const files = readdirSync(sessionsDir, { recursive: true });
				const jsonlFiles = files.filter((f) => f.toString().endsWith(".jsonl"));
				expect(jsonlFiles.length).toBe(0);
			}
		});
	});

	describe("Session Continuation", () => {
		it("should mark existing sessions as initialized immediately", () => {
			// First, create a session
			const sessionManager1 = new SessionManager(false);
			const state = createMockState();
			state.messages.push(createUserMessage("Test"));

			sessionManager1.startSession(state);
			sessionManager1.saveMessage(state.messages[0]);

			const sessionFile = sessionManager1.getSessionFile();
			expect(existsSync(sessionFile)).toBe(true);

			// Now continue that session
			const sessionManager2 = new SessionManager(true); // continue = true

			// Should be marked as initialized (check by verifying shouldInitializeSession returns false)
			const mockMessages = [
				createUserMessage("test"),
				createAssistantMessage("response"),
			];
			expect(sessionManager2.shouldInitializeSession(mockMessages)).toBe(false);
		});

		it("should not create new file when continuing existing session", () => {
			// Create initial session
			const sessionManager1 = new SessionManager(false);
			const state = createMockState();
			state.messages.push(createUserMessage("Test"));

			sessionManager1.startSession(state);
			const originalFile = sessionManager1.getSessionFile();

			// Continue the session
			const sessionManager2 = new SessionManager(true);

			// Should use same file
			expect(sessionManager2.getSessionFile()).toBe(originalFile);

			// Should not create duplicate
			const sessionsDir = join(testDir, "sessions");
			const files = readdirSync(sessionsDir, { recursive: true });
			const jsonlFiles = files.filter((f) => f.toString().endsWith(".jsonl"));
			expect(jsonlFiles.length).toBe(1);
		});
	});

	describe("Custom Session Path", () => {
		it("should mark custom session as initialized if file exists", () => {
			// Create a session normally
			const sessionManager1 = new SessionManager(false);
			const state = createMockState();
			state.messages.push(createUserMessage("Test"));
			sessionManager1.startSession(state);

			const existingFile = sessionManager1.getSessionFile();

			// Load that specific session
			const sessionManager2 = new SessionManager(false, existingFile);

			// Should be marked as initialized (check by verifying shouldInitializeSession returns false)
			const mockMessages = [
				createUserMessage("test"),
				createAssistantMessage("response"),
			];
			expect(sessionManager2.shouldInitializeSession(mockMessages)).toBe(false);
		});

		it("should NOT mark custom session as initialized if file doesn't exist", () => {
			const nonExistentFile = join(testDir, "nonexistent-session.jsonl");

			const sessionManager = new SessionManager(false, nonExistentFile);

			// Should not be marked as initialized (check by verifying shouldInitializeSession can return true)
			const mockMessages = [
				createUserMessage("test"),
				createAssistantMessage("response"),
			];
			expect(sessionManager.shouldInitializeSession(mockMessages)).toBe(true);

			// File should not exist until startSession
			expect(existsSync(nonExistentFile)).toBe(false);
		});
	});

	describe("Session Disable (--no-session)", () => {
		it("should never create file when session is disabled", () => {
			const sessionManager = new SessionManager(false);
			sessionManager.disable();

			const state = createMockState();
			state.messages.push(createUserMessage("Test"));

			sessionManager.saveMessage(state.messages[0]);
			sessionManager.startSession(state);

			const sessionFile = sessionManager.getSessionFile();
			expect(existsSync(sessionFile)).toBe(false);
		});

		it("should not queue messages when disabled", () => {
			const sessionManager = new SessionManager(false);
			sessionManager.disable();

			sessionManager.saveMessage(createUserMessage("Message 1"));
			sessionManager.saveMessage(createUserMessage("Message 2"));

			// Should not have queued anything (can't directly test, but load should return empty)
			const loadedMessages = sessionManager.loadMessages();
			expect(loadedMessages.length).toBe(0);
		});
	});

	describe("Edge Cases", () => {
		it("should handle calling startSession multiple times", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();

			// Call startSession twice
			sessionManager.startSession(state);
			sessionManager.startSession(state);

			// Should only create one session file
			const sessionFile = sessionManager.getSessionFile();
			expect(existsSync(sessionFile)).toBe(true);

			// Should only have one session entry
			const loadedMessages = sessionManager.loadMessages();
			// No messages saved, so should be empty, but file should exist
			expect(Array.isArray(loadedMessages)).toBe(true);
		});

		it("should handle rapid message saves before session init", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();

			// Rapidly save many messages
			for (let i = 0; i < 100; i++) {
				sessionManager.saveMessage(createUserMessage(`Message ${i}`));
			}

			// Start session
			sessionManager.startSession(state);

			// All messages should be flushed
			const loadedMessages = sessionManager.loadMessages();
			expect(loadedMessages.length).toBe(100);
		});

		it("should handle model changes before session init", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();

			// Change model before session init
			sessionManager.saveModelChange("openai/gpt-4", {
				provider: "openai",
				modelId: "gpt-4",
			});
			sessionManager.saveModelChange("anthropic/claude-sonnet-4", {
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			});

			// Start session
			sessionManager.startSession(state);

			// Should have persisted changes
			const sessionFile = sessionManager.getSessionFile();
			expect(existsSync(sessionFile)).toBe(true);
		});

		it("should handle thinking level changes before session init", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();

			// Change thinking level before session init
			sessionManager.saveThinkingLevelChange("medium");
			sessionManager.saveThinkingLevelChange("high");

			// Start session
			sessionManager.startSession(state);

			// Should have persisted changes
			const loadedLevel = sessionManager.loadThinkingLevel();
			expect(loadedLevel).toBe("high");
		});
	});

	describe("startFreshSession", () => {
		it("rotates the session file and clears metadata", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage("Investigate api regressions");
			state.messages.push(userMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			const firstFile = sessionManager.getSessionFile();
			expect(existsSync(firstFile)).toBe(true);

			sessionManager.saveThinkingLevelChange("high");
			sessionManager.startFreshSession();

			const secondFile = sessionManager.getSessionFile();
			expect(secondFile).not.toBe(firstFile);
			expect(existsSync(secondFile)).toBe(false);
			expect(sessionManager.loadModel()).toBeNull();

			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			expect(existsSync(secondFile)).toBe(true);
		});
	});
});
