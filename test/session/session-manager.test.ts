import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentState } from "../../src/agent/types.js";
import { UNIFIED_CONTEXT_MANIFEST_PROTOCOL } from "../../src/context/manifest-types.js";
import { exportSessionToJson } from "../../src/export-html.js";
import {
	SessionManager,
	flushPendingSessionAutoPrunesForTests,
	resetSessionAutoPruneForTests,
} from "../../src/session/manager.js";
import type { SessionHeaderEntry } from "../../src/session/types.js";

// Helper to create a minimal agent state
function createMockState(): AgentState {
	return {
		steeringMode: "all",
		followUpMode: "all",
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

function createPromptContextManifest() {
	return {
		cwd: "/repo",
		candidates: ["AGENTS.md"],
		maxBytes: 32768,
		bytesRead: 10,
		entries: [
			{
				path: "/repo/AGENTS.md",
				sourceKind: "project" as const,
				scopeDir: "/repo",
				candidateName: "AGENTS.md",
				bytesRead: 10,
				truncated: false,
				contentHash: "a".repeat(64),
				precedenceIndex: 0,
				content: "guidance",
			},
		],
		diagnostics: [],
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

function createHookMessage(text: string, details?: Record<string, unknown>) {
	return {
		role: "hookMessage" as const,
		customType: "test-hook",
		content: text,
		display: false,
		details,
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

function createAssistantToolCallMessage() {
	return {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text: "Reading the file" },
			{
				type: "toolCall" as const,
				id: "call_1",
				name: "read",
				arguments: { path: "README.md" },
			},
		],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-sonnet-4",
		stopReason: "toolUse" as const,
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

function createToolResultMessage() {
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "read",
		content: [{ type: "text" as const, text: "file contents" }],
		isError: false,
		timestamp: Date.now(),
	};
}

function readSessionHeader(filePath: string): SessionHeaderEntry {
	const header = readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
		.find((entry) => entry.type === "session") as
		| SessionHeaderEntry
		| undefined;
	if (!header) {
		throw new Error(`Missing session header in ${filePath}`);
	}
	return header;
}

function readSessionEntries(filePath: string) {
	return readFileSync(filePath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

describe("SessionManager - Deferred Session Creation", () => {
	let testDir: string;
	let originalEnv: string | undefined;
	let originalCwd: string;

	beforeEach(() => {
		// Save original state
		originalCwd = process.cwd();
		originalEnv = process.env.MAESTRO_AGENT_DIR;

		// Create temp test directory for sessions
		testDir = join(tmpdir(), `composer-sessions-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
		process.env.MAESTRO_AGENT_DIR = testDir;

		// Change to test directory
		process.chdir(testDir);
	});

	describe("Session metadata", () => {
		it("does not keep short-lived processes alive for background auto-prune", () => {
			const unref = vi.fn();
			const setTimeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockImplementation(
					((
						_handler: Parameters<typeof setTimeout>[0],
						_timeout?: Parameters<typeof setTimeout>[1],
						..._args: unknown[]
					) =>
						({
							unref,
						}) as unknown as ReturnType<
							typeof setTimeout
						>) as typeof setTimeout,
				);

			try {
				const sessionManager = new SessionManager(false);
				sessionManager.startSession(createMockState());

				expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
				expect(unref).toHaveBeenCalled();
			} finally {
				setTimeoutSpy.mockRestore();
			}
		});

		it("preserves pending auto-prune for short-lived processes", () => {
			const unref = vi.fn();
			const setTimeoutSpy = vi
				.spyOn(globalThis, "setTimeout")
				.mockImplementation(
					((
						_handler: Parameters<typeof setTimeout>[0],
						_timeout?: Parameters<typeof setTimeout>[1],
						..._args: unknown[]
					) =>
						({
							unref,
						}) as unknown as ReturnType<
							typeof setTimeout
						>) as typeof setTimeout,
				);

			try {
				const sessionManager = new SessionManager(false);
				const pruneSpy = vi
					.spyOn(sessionManager, "pruneSessions")
					.mockReturnValue({ removed: 0, errors: 0 });

				sessionManager.startSession(createMockState());

				expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
				expect(unref).toHaveBeenCalled();
				expect(pruneSpy).not.toHaveBeenCalled();

				flushPendingSessionAutoPrunesForTests();

				expect(pruneSpy).toHaveBeenCalledTimes(1);

				flushPendingSessionAutoPrunesForTests();

				expect(pruneSpy).toHaveBeenCalledTimes(1);
			} finally {
				setTimeoutSpy.mockRestore();
			}
		});

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
			expect(sessions[0]!.summary).toContain("Deeply review the codebase");
			expect(sessions[0]!.favorite).toBe(false);

			sessionManager.setSessionFavorite(sessions[0]!.path, true);
			const updated = sessionManager.loadAllSessions();
			expect(updated[0]!.favorite).toBe(true);
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
			expect(sessions[0]!.summary).toBe("Custom curated summary");
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

		it("persists prompt metadata in the session header", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			state.promptMetadata = {
				name: "maestro-system",
				label: "production",
				surface: "maestro",
				version: 7,
				versionId: "ver_7",
				hash: "abc123",
				source: "service",
			};

			sessionManager.startSession(state);

			expect(sessionManager.getHeader()?.promptMetadata).toEqual(
				state.promptMetadata,
			);
		});

		it("persists prompt context manifest in the session header", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			state.promptContextManifest = createPromptContextManifest();

			sessionManager.startSession(state);

			expect(sessionManager.getHeader()?.promptContextManifest).toEqual(
				state.promptContextManifest,
			);
		});

		it("persists systemPromptSourcePaths in the session header", () => {
			// Regression test for #2602: when a session is resumed and a
			// previously loaded append/source path no longer exists on disk,
			// compaction must still exclude that path from read-restore. The
			// persisted snapshot is the bridge that keeps that exclusion alive
			// across resume.
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			state.systemPromptSourcePaths = [
				"/workspace/.maestro/APPEND_SYSTEM.md",
				"/workspace/AGENT.md",
			];

			sessionManager.startSession(state);

			expect(sessionManager.getHeader()?.systemPromptSourcePaths).toEqual([
				"/workspace/.maestro/APPEND_SYSTEM.md",
				"/workspace/AGENT.md",
			]);
			expect(
				readSessionHeader(sessionManager.getSessionFile())
					.systemPromptSourcePaths,
			).toEqual([
				"/workspace/.maestro/APPEND_SYSTEM.md",
				"/workspace/AGENT.md",
			]);
		});

		it("omits systemPromptSourcePaths when none were loaded", () => {
			// The field is optional; missing/empty state must produce a header
			// without the key so existing readers keep working unchanged.
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			state.systemPromptSourcePaths = [];

			sessionManager.startSession(state);

			expect(
				sessionManager.getHeader()?.systemPromptSourcePaths,
			).toBeUndefined();
		});

		it("persists unified context manifest in the session header", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const promptContextManifest = createPromptContextManifest();
			state.promptContextManifest = promptContextManifest;
			state.unifiedContextManifest = {
				protocolVersion: UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
				version: 1,
				cwd: "/repo",
				projectDocs: promptContextManifest,
				entries: [
					{
						id: "project_doc:project:AGENTS.md",
						kind: "project_doc",
						source: "filesystem",
						status: "loaded",
						label: "AGENTS.md",
						path: "/repo/AGENTS.md",
						scopeDir: "/repo",
						precedenceIndex: 0,
						bytesRead: 10,
						contentHash: "a".repeat(64),
						metadata: {
							sourceKind: "project",
							truncated: false,
						},
					},
				],
				diagnostics: [],
			};

			sessionManager.startSession(state);

			expect(sessionManager.getHeader()?.unifiedContextManifest).toEqual(
				state.unifiedContextManifest,
			);
			expect(
				readSessionHeader(sessionManager.getSessionFile())
					.unifiedContextManifest,
			).toEqual(state.unifiedContextManifest);
		});

		it("can backfill unified context manifest after the session starts", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const promptContextManifest = createPromptContextManifest();
			state.promptContextManifest = promptContextManifest;
			const unifiedContextManifest = {
				protocolVersion: UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
				version: 1,
				cwd: "/repo",
				projectDocs: promptContextManifest,
				entries: [
					{
						id: "project_doc:project:AGENTS.md",
						kind: "project_doc" as const,
						source: "filesystem" as const,
						status: "loaded" as const,
						label: "AGENTS.md",
						path: "/repo/AGENTS.md",
						scopeDir: "/repo",
						precedenceIndex: 0,
						bytesRead: 10,
						contentHash: "a".repeat(64),
						metadata: {
							sourceKind: "project",
							truncated: false,
						},
					},
				],
				diagnostics: [],
			};

			sessionManager.startSession(state);
			expect(
				sessionManager.getHeader()?.unifiedContextManifest,
			).toBeUndefined();

			expect(
				sessionManager.updateUnifiedContextManifest(unifiedContextManifest),
			).toBe(true);

			expect(sessionManager.getHeader()?.unifiedContextManifest).toEqual(
				unifiedContextManifest,
			);
			expect(
				readSessionHeader(sessionManager.getSessionFile())
					.unifiedContextManifest,
			).toEqual(unifiedContextManifest);
		});

		it("does not duplicate buffered entries when backfilling the unified context manifest", async () => {
			const sessionManager = new SessionManager(false);
			const promptContextManifest = createPromptContextManifest();
			const state = createMockState();
			state.promptContextManifest = promptContextManifest;
			const userMessage = createUserMessage("Summarize release notes");
			const assistantMessage = createAssistantMessage(
				"Release notes summarized",
			);
			state.messages.push(userMessage, assistantMessage);
			const unifiedContextManifest = {
				protocolVersion: UNIFIED_CONTEXT_MANIFEST_PROTOCOL,
				version: 1,
				cwd: "/repo",
				projectDocs: promptContextManifest,
				entries: [
					{
						id: "project_doc:project:AGENTS.md",
						kind: "project_doc" as const,
						source: "filesystem" as const,
						status: "loaded" as const,
						label: "AGENTS.md",
						path: "/repo/AGENTS.md",
						scopeDir: "/repo",
						precedenceIndex: 0,
						bytesRead: 10,
						contentHash: "a".repeat(64),
						metadata: {
							sourceKind: "project",
							truncated: false,
						},
					},
				],
				diagnostics: [],
			};

			sessionManager.startSession(state);
			sessionManager.saveMessage(userMessage);
			sessionManager.saveMessage(assistantMessage);

			expect(
				sessionManager.updateUnifiedContextManifest(unifiedContextManifest),
			).toBe(true);
			await sessionManager.flush();

			const entries = readSessionEntries(sessionManager.getSessionFile());
			expect(entries.map((entry) => entry.type)).toEqual([
				"session",
				"message",
				"message",
			]);
			expect(entries.filter((entry) => entry.type === "message")).toHaveLength(
				2,
			);
			expect(readSessionHeader(sessionManager.getSessionFile())).toMatchObject({
				unifiedContextManifest,
			});
		});
	});

	describe("Portable session import", () => {
		it("imports jsonl sessions into the current workspace directory", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage("Carry this session elsewhere");
			const assistantMessage = createAssistantMessage(
				"Portable session payload ready",
			);
			state.messages.push(userMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			sessionManager.saveMessage(assistantMessage);
			await sessionManager.flush();

			const originalId = sessionManager.getSessionId();
			const originalFile = sessionManager.getSessionFile();
			const imported = sessionManager.importSessionJsonl(originalFile);

			expect(existsSync(imported.sessionFile)).toBe(true);
			expect(imported.sessionId).not.toBe(originalId);

			const restored = new SessionManager(false, imported.sessionFile);
			expect(restored.getSessionId()).toBe(imported.sessionId);
			expect(restored.loadMessages()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "user" }),
					expect.objectContaining({ role: "assistant" }),
				]),
			);
		});

		it("imports portable JSON session exports into the current workspace directory", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage(
				"Carry this JSON session elsewhere",
			);
			const assistantMessage = createAssistantMessage(
				"Portable JSON session payload ready",
			);
			state.messages.push(userMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			sessionManager.saveMessage(assistantMessage);
			await sessionManager.flush();

			const originalId = sessionManager.getSessionId();
			const originalFile = sessionManager.getSessionFile();
			const entries = readFileSync(originalFile, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
			const portablePath = join(testDir, "portable-session.json");
			writeFileSync(
				portablePath,
				JSON.stringify({
					format: "maestro-session-export.v1",
					exportedAt: new Date().toISOString(),
					entries,
				}),
				"utf8",
			);

			const imported = sessionManager.importPortableSession(portablePath);

			expect(existsSync(imported.sessionFile)).toBe(true);
			expect(imported.sessionId).not.toBe(originalId);

			const restored = new SessionManager(false, imported.sessionFile);
			expect(restored.getSessionId()).toBe(imported.sessionId);
			expect(restored.loadMessages()).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ role: "user" }),
					expect.objectContaining({ role: "assistant" }),
				]),
			);
		});

		it("exports and imports bundled session trees for branched sessions", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const userMessage = createUserMessage("Root session message");
			const assistantMessage = createAssistantMessage("Root assistant reply");
			state.messages.push(userMessage, assistantMessage);
			sessionManager.saveMessage(userMessage);
			sessionManager.startSession(state);
			sessionManager.saveMessage(assistantMessage);
			await sessionManager.flush();

			const rootSessionId = sessionManager.getSessionId();
			const rootSessionFile = sessionManager.getSessionFile();
			const branchFile = sessionManager.createBranchedSession(state, 1);
			const branchHeader = readSessionHeader(branchFile);
			expect(branchHeader.parentSession).toBe(rootSessionId);
			expect(branchHeader.branchedFrom).toBe(rootSessionFile);

			const portablePath = join(testDir, "portable-session-tree.json");
			await exportSessionToJson(sessionManager, portablePath);
			const exported = JSON.parse(readFileSync(portablePath, "utf8")) as {
				sessionId: string;
				sessions: Array<{
					sessionId: string;
					parentSessionId?: string | null;
					entries: Array<{ type: string }>;
				}>;
			};
			expect(exported.sessionId).toBe(rootSessionId);
			expect(exported.sessions).toHaveLength(2);
			expect(
				exported.sessions.find(
					(session) => session.sessionId === rootSessionId,
				),
			).toBeDefined();
			expect(
				exported.sessions.find(
					(session) => session.parentSessionId === rootSessionId,
				),
			).toBeDefined();

			const imported = sessionManager.importPortableSession(portablePath);
			expect(imported.importedCount).toBe(2);

			const importedRootFile = sessionManager.getSessionFileById(
				imported.sessionId,
			);
			expect(importedRootFile).toBeTruthy();
			const importedRootHeader = readSessionHeader(importedRootFile!);
			expect(importedRootHeader.parentSession).toBeUndefined();
			expect(importedRootHeader.branchedFrom).toBeUndefined();

			const sessionDir = dirname(rootSessionFile);
			const importedChildFile = readdirSync(sessionDir)
				.map((fileName) => join(sessionDir, fileName))
				.find(
					(filePath) =>
						readSessionHeader(filePath).parentSession === imported.sessionId,
				);
			expect(importedChildFile).toBeTruthy();
			const importedChildHeader = readSessionHeader(importedChildFile!);
			expect(importedChildHeader.parentSession).toBe(imported.sessionId);
			expect(importedChildHeader.branchedFrom).toBe(importedRootFile);
		});
	});

	afterEach(() => {
		resetSessionAutoPruneForTests();
		// Restore original state
		process.chdir(originalCwd);
		if (originalEnv === undefined) {
			Reflect.deleteProperty(process.env, "MAESTRO_AGENT_DIR");
		} else {
			process.env.MAESTRO_AGENT_DIR = originalEnv;
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
			sessionManager.saveMessage(state.messages[0]!);

			// Still no file
			expect(existsSync(sessionFile)).toBe(false);

			// Now start the session (typically after first assistant response)
			sessionManager.startSession(state);

			// File should now exist
			expect(existsSync(sessionFile)).toBe(true);
		});

		it("creates session directories and files with owner-only permissions", () => {
			if (process.platform === "win32") return;
			const sessionManager = new SessionManager(false);
			const sessionFile = sessionManager.getSessionFile();
			const state = createMockState();
			state.messages.push(createUserMessage("Hello"));
			sessionManager.saveMessage(state.messages[0]!);
			sessionManager.startSession(state);

			expect(statSync(dirname(sessionFile)).mode & 0o777).toBe(0o700);
			expect(statSync(sessionFile).mode & 0o777).toBe(0o600);
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
			sessionManager1.saveMessage(state.messages[0]!);

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

			sessionManager.saveMessage(state.messages[0]!);
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

	describe("Session Sanitization", () => {
		it("persists a late tool result after the assistant message and de-duplicates replay", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			sessionManager.saveMessage(createAssistantToolCallMessage());
			sessionManager.saveMessage(createToolResultMessage());
			sessionManager.saveMessage(createToolResultMessage());
			await sessionManager.flush();

			const entries = readSessionEntries(sessionManager.getSessionFile());
			const messages = entries
				.filter((entry) => entry.type === "message")
				.map((entry) => entry.message);
			const toolResults = messages.filter(
				(message) =>
					message.role === "toolResult" && message.toolCallId === "call_1",
			);

			expect(toolResults).toHaveLength(1);
			expect(messages.map((message) => message.role)).toEqual([
				"assistant",
				"toolResult",
			]);
		});

		it("redacts secrets in tool results before persistence", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const secret = "sk-ant-1234567890abcdef1234";
			const toolResult = {
				role: "toolResult" as const,
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text" as const, text: `token=${secret}` }],
				details: { apiKey: secret },
				isError: false,
				timestamp: Date.now(),
			};

			sessionManager.saveMessage(toolResult);

			const messages = sessionManager.loadMessages();
			const saved = messages.find((message) => message.role === "toolResult") as
				| typeof toolResult
				| undefined;

			expect(saved).toBeTruthy();
			if (!saved) return;
			const text = (saved.content[0] as { type: "text"; text: string }).text;
			expect(text).toContain("[REDACTED:");
			expect(text).not.toContain(secret);

			const details = saved.details as { apiKey: string };
			expect(details.apiKey).toContain("[REDACTED:");
			expect(details.apiKey).not.toContain(secret);
		});

		it("redacts secrets in user messages before persistence", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const secret = "sk-ant-1234567890abcdef1234";
			sessionManager.saveMessage(createUserMessage(`token=${secret}`));
			sessionManager.saveMessage({
				role: "user",
				content: `inline token=${secret}`,
				timestamp: Date.now(),
			});

			const savedUsers = sessionManager
				.loadMessages()
				.filter((message) => message.role === "user");

			expect(savedUsers).toHaveLength(2);
			for (const saved of savedUsers) {
				const content =
					typeof saved.content === "string"
						? saved.content
						: saved.content
								.filter((block) => block.type === "text")
								.map((block) => block.text)
								.join("\n");
				expect(content).toContain("[REDACTED:");
				expect(content).not.toContain(secret);
			}
		});

		it("preserves long clean user and hook text while redacting secrets", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const longCleanText = `clean-${"a".repeat(5000)}`;
			sessionManager.saveMessage(createUserMessage(longCleanText));
			sessionManager.saveMessage(createHookMessage(longCleanText));

			const savedMessages = sessionManager.loadMessages();
			const savedUser = savedMessages.find(
				(message) => message.role === "user",
			);
			const savedHook = savedMessages.find(
				(message) => message.role === "hookMessage",
			);

			expect(savedUser?.content).toEqual([
				{ type: "text", text: longCleanText },
			]);
			expect(savedHook?.content).toBe(longCleanText);
			expect(JSON.stringify(savedMessages)).not.toContain("[truncated:");
		});

		it("preserves long clean metadata and details before persistence", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const longCleanText = `clean-${"a".repeat(5000)}`;
			const base64LikeText = "A".repeat(5000);
			sessionManager.saveMessage({
				...createUserMessage("safe content"),
				metadata: {
					longCleanText,
					base64LikeText,
				},
			});
			sessionManager.saveMessage(
				createHookMessage("hook content", {
					longCleanText,
					base64LikeText,
				}),
			);
			sessionManager.appendCustomMessageEntry(
				"hook-send-message",
				"hook content",
				true,
				{
					longCleanText,
					base64LikeText,
				},
			);
			await sessionManager.flush();

			const savedMessages = sessionManager.loadMessages();
			const savedUser = savedMessages.find(
				(message) => message.role === "user",
			) as
				| {
						metadata?: {
							longCleanText?: string;
							base64LikeText?: string;
						};
				  }
				| undefined;
			const savedHook = savedMessages.find(
				(message) => message.role === "hookMessage",
			) as
				| {
						details?: {
							longCleanText?: string;
							base64LikeText?: string;
						};
				  }
				| undefined;
			const customEntry = readSessionEntries(
				sessionManager.getSessionFile(),
			).find((entry) => entry.type === "custom_message") as
				| {
						details?: {
							longCleanText?: string;
							base64LikeText?: string;
						};
				  }
				| undefined;

			expect(savedUser?.metadata).toEqual({ longCleanText, base64LikeText });
			expect(savedHook?.details).toEqual({ longCleanText, base64LikeText });
			expect(customEntry?.details).toEqual({ longCleanText, base64LikeText });
			expect(JSON.stringify(savedMessages)).not.toContain("[truncated:");
			expect(JSON.stringify(savedMessages)).not.toContain("[base64:");
			expect(JSON.stringify(customEntry)).not.toContain("[truncated:");
			expect(JSON.stringify(customEntry)).not.toContain("[base64:");
		});

		it("preserves long clean metadata and details arrays before persistence", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const longCleanArray = Array.from({ length: 125 }, (_, index) => ({
				index,
				label: `item-${index}`,
			}));
			sessionManager.saveMessage({
				...createUserMessage("safe content"),
				metadata: {
					items: longCleanArray,
				},
			});
			sessionManager.saveMessage(
				createHookMessage("hook content", {
					items: longCleanArray,
				}),
			);
			sessionManager.appendCustomMessageEntry(
				"hook-send-message",
				"hook content",
				true,
				{
					items: longCleanArray,
				},
			);
			await sessionManager.flush();

			const savedMessages = sessionManager.loadMessages();
			const savedUser = savedMessages.find(
				(message) => message.role === "user",
			) as
				| {
						metadata?: {
							items?: typeof longCleanArray;
						};
				  }
				| undefined;
			const savedHook = savedMessages.find(
				(message) => message.role === "hookMessage",
			) as
				| {
						details?: {
							items?: typeof longCleanArray;
						};
				  }
				| undefined;
			const customEntry = readSessionEntries(
				sessionManager.getSessionFile(),
			).find((entry) => entry.type === "custom_message") as
				| {
						details?: {
							items?: typeof longCleanArray;
						};
				  }
				| undefined;

			expect(savedUser?.metadata?.items).toEqual(longCleanArray);
			expect(savedHook?.details?.items).toEqual(longCleanArray);
			expect(customEntry?.details?.items).toEqual(longCleanArray);
			expect(JSON.stringify(savedMessages)).not.toContain("more items");
			expect(JSON.stringify(customEntry)).not.toContain("more items");
		});

		it("redacts secrets in user attachment payloads before persistence", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const secret = "sk-ant-1234567890abcdef1234";
			const fileText = `OPENAI_API_KEY=${secret}\n`;
			sessionManager.saveMessage({
				role: "user",
				content: "see attached env",
				attachments: [
					{
						id: "att-env",
						type: "document",
						fileName: "secrets.env",
						mimeType: "text/plain",
						size: fileText.length,
						content: Buffer.from(fileText, "utf8").toString("base64"),
						extractedText: `The key is ${secret}`,
					},
				],
				timestamp: Date.now(),
			});

			const savedUser = sessionManager
				.loadMessages()
				.find(
					(message) => message.role === "user" && "attachments" in message,
				) as
				| {
						attachments?: Array<{
							content: string;
							extractedText?: string;
						}>;
				  }
				| undefined;
			const attachment = savedUser?.attachments?.[0];
			expect(attachment).toBeTruthy();
			if (!attachment) return;

			const decodedContent = Buffer.from(attachment.content, "base64").toString(
				"utf8",
			);
			expect(decodedContent).toContain("[REDACTED:");
			expect(decodedContent).not.toContain(secret);
			expect(attachment.extractedText).toContain("[REDACTED:");
			expect(attachment.extractedText).not.toContain(secret);
		});

		it("redacts secrets in attachment extract cache entries on save and reload", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			sessionManager.saveMessage({
				role: "user",
				content: "extract this attachment",
				attachments: [
					{
						id: "att-cache",
						type: "document",
						fileName: "notes.txt",
						mimeType: "text/plain",
						size: 5,
						content: Buffer.from("hello", "utf8").toString("base64"),
					},
				],
				timestamp: Date.now(),
			});

			const secret = "sk-ant-1234567890abcdef1234";
			const legacySecret = "sk-ant-fedcba0987654321abcd";
			const sessionFile = sessionManager.getSessionFile();
			sessionManager.saveAttachmentExtraction(
				sessionFile,
				"att-cache",
				`Cached key ${secret}`,
			);
			await sessionManager.flush();

			const attachmentExtractEntries = readSessionEntries(sessionFile).filter(
				(entry) => entry.type === "attachment_extract",
			) as Array<{ extractedText: string }>;
			expect(attachmentExtractEntries).toHaveLength(1);
			expect(attachmentExtractEntries[0]?.extractedText).toContain(
				"[REDACTED:",
			);
			expect(attachmentExtractEntries[0]?.extractedText).not.toContain(secret);

			const legacyEntry = JSON.stringify({
				type: "attachment_extract",
				timestamp: new Date().toISOString(),
				attachmentId: "att-cache",
				extractedText: `Legacy cache ${legacySecret}`,
			});
			writeFileSync(
				sessionFile,
				`${readFileSync(sessionFile, "utf8")}${legacyEntry}\n`,
				"utf8",
			);

			const restored = new SessionManager(false, sessionFile);
			const savedUser = restored
				.loadMessages()
				.find(
					(message) => message.role === "user" && "attachments" in message,
				) as
				| {
						attachments?: Array<{
							extractedText?: string;
						}>;
				  }
				| undefined;
			const attachment = savedUser?.attachments?.[0];
			expect(attachment).toBeTruthy();
			expect(attachment?.extractedText).toContain("Legacy cache");
			expect(attachment?.extractedText).toContain("[REDACTED:");
			expect(attachment?.extractedText).not.toContain(legacySecret);
		});

		it("redacts secrets in user metadata and hook details before persistence", () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const secret = "sk-ant-1234567890abcdef1234";
			sessionManager.saveMessage({
				role: "user",
				content: "safe content",
				metadata: { apiKey: secret },
				timestamp: Date.now(),
			});
			sessionManager.saveMessage(
				createHookMessage("hook content", { apiKey: secret }),
			);

			const savedMessages = sessionManager.loadMessages();
			const savedUser = savedMessages.find(
				(message) =>
					message.role === "user" && typeof message.content === "string",
			) as { metadata?: { apiKey: string } } | undefined;
			const savedHook = savedMessages.find(
				(message) => message.role === "hookMessage",
			) as { details?: { apiKey: string } } | undefined;

			expect(savedUser?.metadata?.apiKey).toContain("[REDACTED:");
			expect(savedUser?.metadata?.apiKey).not.toContain(secret);
			expect(savedHook?.details?.apiKey).toContain("[REDACTED:");
			expect(savedHook?.details?.apiKey).not.toContain(secret);
		});

		it("redacts custom-message entries appended by hooks before persistence", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			sessionManager.startSession(state);

			const secret = "sk-ant-1234567890abcdef1234";
			sessionManager.appendCustomMessageEntry(
				"hook-send-message",
				`hook token=${secret}`,
				true,
				{ apiKey: secret },
			);
			await sessionManager.flush();

			const customEntry = readSessionEntries(
				sessionManager.getSessionFile(),
			).find((entry) => entry.type === "custom_message") as
				| {
						content: string;
						details?: { apiKey: string };
				  }
				| undefined;
			expect(customEntry?.content).toContain("[REDACTED:");
			expect(customEntry?.content).not.toContain(secret);
			expect(customEntry?.details?.apiKey).toContain("[REDACTED:");
			expect(customEntry?.details?.apiKey).not.toContain(secret);

			const savedHook = sessionManager
				.loadMessages()
				.find((message) => message.role === "hookMessage") as
				| { content: string; details?: { apiKey: string } }
				| undefined;
			expect(savedHook?.content).toContain("[REDACTED:");
			expect(savedHook?.content).not.toContain(secret);
			expect(savedHook?.details?.apiKey).toContain("[REDACTED:");
			expect(savedHook?.details?.apiKey).not.toContain(secret);
		});

		it("redacts secrets when branching from in-memory state", async () => {
			const sessionManager = new SessionManager(false);
			const state = createMockState();
			const secret = "sk-ant-1234567890abcdef1234";
			const userMessage = {
				role: "user" as const,
				content: `token=${secret}`,
				metadata: { apiKey: secret },
				timestamp: Date.now(),
			};
			const hookMessage = createHookMessage(`token=${secret}`, {
				apiKey: secret,
			});

			state.messages.push(userMessage, hookMessage);
			sessionManager.startSession(state);
			sessionManager.saveMessage(userMessage);
			sessionManager.saveMessage(hookMessage);
			await sessionManager.flush();

			const branchFile = sessionManager.createBranchedSession(state, 2);
			const branchEntries = readSessionEntries(branchFile).filter(
				(entry) => entry.type === "message",
			) as Array<{
				message: {
					role: string;
					content: string;
					metadata?: { apiKey: string };
					details?: { apiKey: string };
				};
			}>;
			const [savedUser, savedHook] = branchEntries.map(
				(entry) => entry.message,
			);

			expect(savedUser.content).toContain("[REDACTED:");
			expect(savedUser.content).not.toContain(secret);
			expect(savedUser.metadata?.apiKey).toContain("[REDACTED:");
			expect(savedUser.metadata?.apiKey).not.toContain(secret);
			expect(savedHook.content).toContain("[REDACTED:");
			expect(savedHook.content).not.toContain(secret);
			expect(savedHook.details?.apiKey).toContain("[REDACTED:");
			expect(savedHook.details?.apiKey).not.toContain(secret);
		});

		it("redacts legacy branch entries when branching from a leaf id", () => {
			const secret = "sk-ant-1234567890abcdef1234";
			const seedManager = new SessionManager(false);
			const legacySessionFile = seedManager.getSessionFile();
			seedManager.disable();

			writeFileSync(
				legacySessionFile,
				`${[
					JSON.stringify({
						type: "session",
						version: 2,
						id: "legacy-session",
						timestamp: new Date().toISOString(),
						cwd: process.cwd(),
					}),
					JSON.stringify({
						type: "message",
						id: "legacy-message",
						parentId: null,
						timestamp: new Date().toISOString(),
						message: {
							role: "user",
							content: `token=${secret}`,
							metadata: { apiKey: secret },
							timestamp: Date.now(),
						},
					}),
					JSON.stringify({
						type: "custom_message",
						customType: "hook-send-message",
						content: `token=${secret}`,
						details: { apiKey: secret },
						display: true,
						id: "legacy-hook-message",
						parentId: "legacy-message",
						timestamp: new Date().toISOString(),
					}),
				].join("\n")}\n`,
				"utf8",
			);

			const legacyManager = new SessionManager(false, legacySessionFile);
			const branchFile = legacyManager.createBranchedSession(
				"legacy-hook-message",
			);
			const branchEntries = readSessionEntries(branchFile);
			const savedMessage = branchEntries.find(
				(entry) => entry.type === "message",
			) as
				| {
						message: {
							content: string;
							metadata?: { apiKey: string };
						};
				  }
				| undefined;
			const savedCustom = branchEntries.find(
				(entry) => entry.type === "custom_message",
			) as
				| {
						content: string;
						details?: { apiKey: string };
				  }
				| undefined;

			expect(savedMessage?.message.content).toContain("[REDACTED:");
			expect(savedMessage?.message.content).not.toContain(secret);
			expect(savedMessage?.message.metadata?.apiKey).toContain("[REDACTED:");
			expect(savedMessage?.message.metadata?.apiKey).not.toContain(secret);
			expect(savedCustom?.content).toContain("[REDACTED:");
			expect(savedCustom?.content).not.toContain(secret);
			expect(savedCustom?.details?.apiKey).toContain("[REDACTED:");
			expect(savedCustom?.details?.apiKey).not.toContain(secret);
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
