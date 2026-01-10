import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../../src/cli-tui/commands/types.js";

// Helper to create mock context
function createMockContext(
	rawInput: string,
	argumentText = "",
): CommandExecutionContext {
	return {
		command: { name: "test", description: "test command" },
		rawInput,
		argumentText,
		showInfo: vi.fn(),
		showError: vi.fn(),
		renderHelp: vi.fn(),
	};
}

describe("Grouped Command Handlers", () => {
	beforeEach(() => {
		vi.useRealTimers();
	});

	describe("SessionCommandHandler", () => {
		it("routes 'new' subcommand to handleNewChat", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss new", "new");

			await handler(ctx);

			expect(deps.handleNewChat).toHaveBeenCalled();
		});

		it("routes 'clear' subcommand to handleClear", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss clear", "clear");

			await handler(ctx);

			expect(deps.handleClear).toHaveBeenCalled();
		});

		it("routes 'list' subcommand to handleSessionsList", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss list", "list");

			await handler(ctx);

			expect(deps.handleSessionsList).toHaveBeenCalled();
		});

		it("defaults to 'info' when no subcommand provided", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss", "");

			await handler(ctx);

			expect(deps.handleSessionInfo).toHaveBeenCalled();
		});

		it("shows help on 'help' subcommand", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss help", "help");

			await handler(ctx);

			expect(ctx.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Session Commands:"),
			);
		});
	});

	describe("DiagCommandHandler", () => {
		const createDiagDeps = () => ({
			handleStatus: vi.fn(),
			handleAbout: vi.fn(),
			handleContext: vi.fn(),
			handleStats: vi.fn(),
			handleBackground: vi.fn(),
			handleDiagnostics: vi.fn(),
			handleTelemetry: vi.fn(),
			handleTraining: vi.fn(),
			handleOtel: vi.fn(),
			handleConfig: vi.fn(),
			handleLsp: vi.fn(),
			handleMcp: vi.fn(),
			handleSources: vi.fn(),
			showInfo: vi.fn(),
			isDatabaseConfigured: vi.fn().mockReturnValue(false),
		});

		it("routes 'status' to handleStatus", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag status", "status");

			await handler(ctx);

			expect(deps.handleStatus).toHaveBeenCalled();
		});

		it("routes 'stats' to handleStats (not handleStatus)", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag stats", "stats");

			await handler(ctx);

			expect(deps.handleStats).toHaveBeenCalled();
			expect(deps.handleStatus).not.toHaveBeenCalled();
		});

		it("routes 'telemetry' to handleTelemetry", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag telemetry", "telemetry");

			await handler(ctx);

			expect(deps.handleTelemetry).toHaveBeenCalled();
		});

		it("routes 'lsp' to handleLsp", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag lsp", "lsp");

			await handler(ctx);

			expect(deps.handleLsp).toHaveBeenCalled();
		});

		it("routes 'mcp' to handleMcp", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag mcp", "mcp");

			await handler(ctx);

			expect(deps.handleMcp).toHaveBeenCalled();
		});

		it("defaults to 'status' when no subcommand provided", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag", "");

			await handler(ctx);

			expect(deps.handleStatus).toHaveBeenCalled();
		});

		it("shows audit info when database not configured", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			deps.isDatabaseConfigured.mockReturnValue(false);
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag audit", "audit");

			await handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Enterprise feature"),
			);
		});
	});

	describe("UiCommandHandler", () => {
		const createUiDeps = () => ({
			handleTheme: vi.fn(),
			handleClean: vi.fn(),
			handleFooter: vi.fn(),
			handleZen: vi.fn(),
			handleCompactTools: vi.fn(),
			showInfo: vi.fn(),
			getUiState: vi.fn().mockReturnValue({
				zenMode: false,
				cleanMode: "off",
				footerMode: "ensemble",
				compactTools: false,
			}),
		});

		it("routes 'theme' to handleTheme", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui theme", "theme");

			handler(ctx);

			expect(deps.handleTheme).toHaveBeenCalled();
		});

		it("routes 'zen' to handleZen", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui zen on", "zen on");

			handler(ctx);

			expect(deps.handleZen).toHaveBeenCalled();
		});

		it("shows UI status when no subcommand provided", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui", "");

			handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("UI Settings:"),
			);
		});

		it("shows error for unknown subcommand", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui invalid", "invalid");

			handler(ctx);

			expect(ctx.showError).toHaveBeenCalledWith(
				expect.stringContaining("Unknown subcommand"),
			);
		});
	});

	describe("SafetyCommandHandler", () => {
		const createSafetyDeps = () => ({
			handleApprovals: vi.fn(),
			handlePlanMode: vi.fn(),
			handleGuardian: vi.fn(),
			showInfo: vi.fn(),
			getSafetyState: vi.fn().mockReturnValue({
				approvalMode: "prompt",
				planMode: false,
				guardianEnabled: true,
			}),
		});

		it("routes 'approvals' to handleApprovals", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe approvals", "approvals");

			await handler(ctx);

			expect(deps.handleApprovals).toHaveBeenCalled();
		});

		it("routes 'plan' to handlePlanMode", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe plan on", "plan on");

			await handler(ctx);

			expect(deps.handlePlanMode).toHaveBeenCalled();
		});

		it("routes 'guardian' to handleGuardian", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe guardian", "guardian");

			await handler(ctx);

			expect(deps.handleGuardian).toHaveBeenCalled();
		});

		it("shows safety status when no subcommand provided", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe", "");

			await handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Safety Settings:"),
			);
		});
	});

	describe("GitCommandHandler", () => {
		const createGitDeps = () => ({
			handleDiff: vi.fn(),
			handleReview: vi.fn(),
			showInfo: vi.fn(),
			runGitCommand: vi.fn().mockResolvedValue(""),
		});

		it("routes 'diff' to handleDiff", async () => {
			const { createGitCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/git-commands.js"
			);

			const deps = createGitDeps();
			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext(
				"/git diff src/index.ts",
				"diff src/index.ts",
			);

			await handler(ctx);

			expect(deps.handleDiff).toHaveBeenCalled();
		});

		it("routes 'review' to handleReview", async () => {
			const { createGitCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/git-commands.js"
			);

			const deps = createGitDeps();
			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext("/git review", "review");

			await handler(ctx);

			expect(deps.handleReview).toHaveBeenCalled();
		});

		it("treats path-like argument as diff", async () => {
			const { createGitCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/git-commands.js"
			);

			const deps = createGitDeps();
			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext("/git src/file.ts", "src/file.ts");

			await handler(ctx);

			expect(deps.handleDiff).toHaveBeenCalled();
		});
	});

	describe("AuthCommandHandler", () => {
		const createAuthDeps = () => ({
			handleLogin: vi.fn(),
			handleLogout: vi.fn(),
			showInfo: vi.fn(),
			getAuthState: vi.fn().mockReturnValue({
				authenticated: false,
				provider: undefined,
				mode: undefined,
			}),
		});

		it("routes 'login' to handleLogin", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth login pro", "login pro");

			await handler(ctx);

			expect(deps.handleLogin).toHaveBeenCalled();
		});

		it("routes 'logout' to handleLogout", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth logout", "logout");

			await handler(ctx);

			expect(deps.handleLogout).toHaveBeenCalled();
		});

		it("shows authenticated status", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			deps.getAuthState.mockReturnValue({
				authenticated: true,
				provider: "anthropic",
				mode: "pro",
			});
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth status", "status");

			await handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Authenticated: yes"),
			);
		});

		it("shows unauthenticated status", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			deps.getAuthState.mockReturnValue({
				authenticated: false,
			});
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth", "");

			await handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("Authenticated: no"),
			);
		});
	});

	describe("UsageCommandHandler", () => {
		const createUsageDeps = () => ({
			handleCost: vi.fn(),
			handleQuota: vi.fn(),
			handleStats: vi.fn(),
		});

		it("routes 'cost' to handleCost", async () => {
			const { createUsageCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage cost", "cost");

			await handler(ctx);

			expect(deps.handleCost).toHaveBeenCalled();
		});

		it("routes 'quota' to handleQuota", async () => {
			const { createUsageCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage quota", "quota");

			await handler(ctx);

			expect(deps.handleQuota).toHaveBeenCalled();
		});

		it("routes 'stats' to handleStats", async () => {
			const { createUsageCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage stats", "stats");

			await handler(ctx);

			expect(deps.handleStats).toHaveBeenCalled();
		});

		it("defaults to stats on empty subcommand", async () => {
			const { createUsageCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage", "");

			await handler(ctx);

			expect(deps.handleStats).toHaveBeenCalled();
		});
	});

	describe("UndoCommandHandler", () => {
		const createUndoDeps = () => ({
			handleUndo: vi.fn(),
			handleCheckpoint: vi.fn(),
			handleChanges: vi.fn(),
			showInfo: vi.fn(),
			getUndoState: vi.fn().mockReturnValue({
				canUndo: true,
				undoCount: 5,
				checkpoints: ["before-refactor", "initial"],
			}),
		});

		it("routes 'undo' to handleUndo", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo", "");

			await handler(ctx);

			expect(deps.handleUndo).toHaveBeenCalled();
		});

		it("routes numeric argument to handleUndo", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo 3", "3");

			await handler(ctx);

			expect(deps.handleUndo).toHaveBeenCalled();
		});

		it("routes 'checkpoint' to handleCheckpoint", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext(
				"/undo checkpoint save test",
				"checkpoint save test",
			);

			await handler(ctx);

			expect(deps.handleCheckpoint).toHaveBeenCalled();
		});

		it("routes 'changes' to handleChanges", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo changes", "changes");

			await handler(ctx);

			expect(deps.handleChanges).toHaveBeenCalled();
		});

		it("shows history with checkpoint list", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo history", "history");

			await handler(ctx);

			expect(deps.showInfo).toHaveBeenCalledWith(
				expect.stringContaining("before-refactor"),
			);
		});
	});

	describe("Context Rewriting", () => {
		it("session handler rewrites context for branch subcommand", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss branch 3", "branch 3");

			await handler(ctx);

			expect(deps.handleBranch).toHaveBeenCalled();
			const receivedCtx = deps.handleBranch.mock.calls[0]![0];
			expect(receivedCtx.rawInput).toBe("/branch 3");
			expect(receivedCtx.argumentText).toBe("3");
		});

		it("diag handler rewrites context for background subcommand", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn(),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn(),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag bg notify on", "bg notify on");

			await handler(ctx);

			expect(deps.handleBackground).toHaveBeenCalled();
			const receivedCtx = deps.handleBackground.mock.calls[0]![0];
			expect(receivedCtx.rawInput).toBe("/background notify on");
			expect(receivedCtx.argumentText).toBe("notify on");
		});

		it("undo handler rewrites context for checkpoint subcommand", async () => {
			const { createUndoCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/undo-commands.js"
			);

			const deps = {
				handleUndo: vi.fn(),
				handleCheckpoint: vi.fn(),
				handleChanges: vi.fn(),
				showInfo: vi.fn(),
				getUndoState: vi.fn().mockReturnValue({
					canUndo: true,
					undoCount: 0,
					checkpoints: [],
				}),
			};

			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext(
				"/undo checkpoint save my-checkpoint",
				"checkpoint save my-checkpoint",
			);

			await handler(ctx);

			expect(deps.handleCheckpoint).toHaveBeenCalled();
			const receivedCtx = deps.handleCheckpoint.mock.calls[0]![0];
			expect(receivedCtx.rawInput).toBe("/checkpoint save my-checkpoint");
			expect(receivedCtx.argumentText).toBe("save my-checkpoint");
		});
	});

	describe("Alias Support", () => {
		it("session handler supports 'ls' alias for list", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss ls", "ls");

			await handler(ctx);

			expect(deps.handleSessionsList).toHaveBeenCalled();
		});

		it("diag handler supports 'health' alias for status", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn(),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn(),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag health", "health");

			await handler(ctx);

			expect(deps.handleStatus).toHaveBeenCalled();
		});

		it("ui handler supports 'color' alias for theme", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = {
				handleTheme: vi.fn(),
				handleClean: vi.fn(),
				handleFooter: vi.fn(),
				handleZen: vi.fn(),
				handleCompactTools: vi.fn(),
				showInfo: vi.fn(),
				getUiState: vi.fn().mockReturnValue({
					zenMode: false,
					cleanMode: "off",
					footerMode: "ensemble",
					compactTools: false,
				}),
			};

			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui color", "color");

			handler(ctx);

			expect(deps.handleTheme).toHaveBeenCalled();
		});

		it("safety handler supports 'approve' alias for approvals", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = {
				handleApprovals: vi.fn(),
				handlePlanMode: vi.fn(),
				handleGuardian: vi.fn(),
				showInfo: vi.fn(),
				getSafetyState: vi.fn().mockReturnValue({
					approvalMode: "prompt",
					planMode: false,
					guardianEnabled: true,
				}),
			};

			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe approve auto", "approve auto");

			await handler(ctx);

			expect(deps.handleApprovals).toHaveBeenCalled();
		});

		it("auth handler supports 'signin' alias for login", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = {
				handleLogin: vi.fn(),
				handleLogout: vi.fn(),
				showInfo: vi.fn(),
				getAuthState: vi.fn().mockReturnValue({
					authenticated: false,
				}),
			};

			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth signin pro", "signin pro");

			await handler(ctx);

			expect(deps.handleLogin).toHaveBeenCalled();
		});
	});

	describe("Async Handler Support", () => {
		it("awaits async stats handler", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			let resolved = false;
			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn().mockImplementation(async () => {
					await new Promise((r) => setTimeout(r, 10));
					resolved = true;
				}),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn(),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag stats", "stats");

			await handler(ctx);

			expect(resolved).toBe(true);
		});

		it("awaits async config handler", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			let resolved = false;
			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn(),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn().mockImplementation(async () => {
					await new Promise((r) => setTimeout(r, 10));
					resolved = true;
				}),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag config", "config");

			await handler(ctx);

			expect(resolved).toBe(true);
		});
	});

	describe("Intelligent Fallbacks", () => {
		it("session handler treats numeric input as session load", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss 5", "5");

			await handler(ctx);

			expect(deps.handleSessionsList).toHaveBeenCalled();
			const receivedCtx = deps.handleSessionsList.mock.calls[0]![0];
			expect(receivedCtx.argumentText).toBe("load 5");
		});

		it("git handler treats path-like input as diff", async () => {
			const { createGitCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/git-commands.js"
			);

			const deps = {
				handleDiff: vi.fn(),
				handleReview: vi.fn(),
				showInfo: vi.fn(),
				runGitCommand: vi.fn().mockResolvedValue(""),
			};

			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext(
				"/git src/components/Button.tsx",
				"src/components/Button.tsx",
			);

			await handler(ctx);

			expect(deps.handleDiff).toHaveBeenCalled();
		});

		it("auth handler treats 'pro' as login mode", async () => {
			const { createAuthCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/auth-commands.js"
			);

			const deps = {
				handleLogin: vi.fn(),
				handleLogout: vi.fn(),
				showInfo: vi.fn(),
				getAuthState: vi.fn().mockReturnValue({
					authenticated: false,
				}),
			};

			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth pro", "pro");

			await handler(ctx);

			expect(deps.handleLogin).toHaveBeenCalled();
		});
	});

	describe("Shared Utilities", () => {
		it("parseSubcommand extracts subcommand and provides rewriteContext", async () => {
			const { parseSubcommand } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			const ctx = createMockContext("/test foo bar baz", "foo bar baz");
			const { subcommand, args, rewriteContext, customContext } =
				parseSubcommand(ctx, "default");

			expect(subcommand).toBe("foo");
			expect(args).toEqual(["foo", "bar", "baz"]);

			const rewritten = rewriteContext("cmd");
			expect(rewritten.rawInput).toBe("/cmd bar baz");
			expect(rewritten.argumentText).toBe("bar baz");

			const custom = customContext("/custom input", "input");
			expect(custom.rawInput).toBe("/custom input");
			expect(custom.argumentText).toBe("input");
		});

		it("parseSubcommand uses default when argumentText is empty", async () => {
			const { parseSubcommand } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			const ctx = createMockContext("/test", "");
			const { subcommand } = parseSubcommand(ctx, "default");

			expect(subcommand).toBe("default");
		});

		it("isHelpRequest recognizes help aliases", async () => {
			const { isHelpRequest } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			expect(isHelpRequest("help")).toBe(true);
			expect(isHelpRequest("?")).toBe(true);
			expect(isHelpRequest("-h")).toBe(true);
			expect(isHelpRequest("--help")).toBe(true);
			expect(isHelpRequest("status")).toBe(false);
		});

		it("isNumericArg validates numeric strings", async () => {
			const { isNumericArg } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			expect(isNumericArg("123")).toBe(true);
			expect(isNumericArg("0")).toBe(true);
			expect(isNumericArg("abc")).toBe(false);
			expect(isNumericArg("12abc")).toBe(false);
			expect(isNumericArg("")).toBe(false);
		});

		it("isSessionId validates session IDs", async () => {
			const { isSessionId } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			expect(isSessionId("abc123")).toBe(true);
			expect(isSessionId("abc-123-def")).toBe(true);
			expect(isSessionId("12345")).toBe(true);
			expect(isSessionId("ABCDEF")).toBe(true);
			expect(isSessionId("new")).toBe(false);
			expect(isSessionId("xyz!")).toBe(false);
		});

		it("matchesAlias checks against alias arrays", async () => {
			const { matchesAlias, COMMON_ALIASES } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			expect(matchesAlias("status", COMMON_ALIASES.status)).toBe(true);
			expect(matchesAlias("st", COMMON_ALIASES.status)).toBe(true);
			expect(matchesAlias("info", COMMON_ALIASES.status)).toBe(true);
			expect(matchesAlias("other", COMMON_ALIASES.status)).toBe(false);

			expect(matchesAlias("on", COMMON_ALIASES.enable)).toBe(true);
			expect(matchesAlias("off", COMMON_ALIASES.disable)).toBe(true);
		});

		it("createSubcommandCompletions returns matching completions", async () => {
			const { createSubcommandCompletions } = await import(
				"../../src/cli-tui/commands/grouped/utils.js"
			);

			const completions = createSubcommandCompletions([
				{ name: "status", description: "Show status", aliases: ["st"] },
				{ name: "list", description: "List items", aliases: ["ls"] },
				{ name: "new", description: "Create new" },
			]);

			// Empty prefix returns all
			const all = completions("");
			expect(all).toHaveLength(3);

			// Prefix filters
			const sMatches = completions("s");
			expect(sMatches).toHaveLength(1);
			expect(sMatches![0]!.value).toBe("status");

			// Alias matches
			const lsMatches = completions("ls");
			expect(lsMatches).toHaveLength(1);
			expect(lsMatches![0]!.value).toBe("list");

			// No matches
			const noMatches = completions("xyz");
			expect(noMatches).toBeNull();

			// Space in prefix returns null (past subcommand)
			const pastSubcommand = completions("status arg");
			expect(pastSubcommand).toBeNull();
		});

		it("predefined subcommand arrays are properly defined", async () => {
			const {
				SESSION_SUBCOMMANDS,
				DIAG_SUBCOMMANDS,
				UI_SUBCOMMANDS,
				SAFETY_SUBCOMMANDS,
				GIT_SUBCOMMANDS,
				AUTH_SUBCOMMANDS,
				USAGE_SUBCOMMANDS,
				UNDO_SUBCOMMANDS,
				CONFIG_SUBCOMMANDS,
				TOOLS_SUBCOMMANDS,
			} = await import("../../src/cli-tui/commands/grouped/utils.js");

			// Check each array has entries with required fields
			expect(SESSION_SUBCOMMANDS.length).toBeGreaterThan(5);
			expect(DIAG_SUBCOMMANDS.length).toBeGreaterThan(5);
			expect(UI_SUBCOMMANDS.length).toBeGreaterThan(3);
			expect(SAFETY_SUBCOMMANDS.length).toBeGreaterThan(2);
			expect(GIT_SUBCOMMANDS.length).toBeGreaterThan(1);
			expect(AUTH_SUBCOMMANDS.length).toBeGreaterThan(1);
			expect(USAGE_SUBCOMMANDS.length).toBeGreaterThan(2);
			expect(UNDO_SUBCOMMANDS.length).toBeGreaterThan(2);
			expect(CONFIG_SUBCOMMANDS.length).toBeGreaterThan(5);
			expect(TOOLS_SUBCOMMANDS.length).toBeGreaterThan(5);

			// Each entry should have name and description
			for (const sub of SESSION_SUBCOMMANDS) {
				expect(sub.name).toBeTruthy();
				expect(sub.description).toBeTruthy();
			}
		});
	});

	describe("ConfigCommandHandler", () => {
		it("routes 'validate' to handleConfig", async () => {
			const { createConfigCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/config-commands.js"
			);

			const deps = {
				handleConfig: vi.fn(),
				handleImport: vi.fn(),
				handleFramework: vi.fn(),
				handleComposer: vi.fn(),
				handleInit: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createConfigCommandHandler(deps);
			const ctx = createMockContext("/cfg validate", "validate");

			await handler(ctx);

			expect(deps.handleConfig).toHaveBeenCalled();
		});

		it("routes 'import' to handleImport", async () => {
			const { createConfigCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/config-commands.js"
			);

			const deps = {
				handleConfig: vi.fn(),
				handleImport: vi.fn(),
				handleFramework: vi.fn(),
				handleComposer: vi.fn(),
				handleInit: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createConfigCommandHandler(deps);
			const ctx = createMockContext("/cfg import factory", "import factory");

			await handler(ctx);

			expect(deps.handleImport).toHaveBeenCalled();
		});

		it("routes 'framework' to handleFramework", async () => {
			const { createConfigCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/config-commands.js"
			);

			const deps = {
				handleConfig: vi.fn(),
				handleImport: vi.fn(),
				handleFramework: vi.fn(),
				handleComposer: vi.fn(),
				handleInit: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createConfigCommandHandler(deps);
			const ctx = createMockContext("/cfg framework react", "framework react");

			await handler(ctx);

			expect(deps.handleFramework).toHaveBeenCalled();
		});
	});

	describe("ToolsCommandHandler", () => {
		it("routes 'list' to handleTools", async () => {
			const { createToolsCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/tools-commands.js"
			);

			const deps = {
				handleTools: vi.fn(),
				handleMcp: vi.fn(),
				handleLsp: vi.fn(),
				handleWorkflow: vi.fn(),
				handleRun: vi.fn(),
				handleCommands: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createToolsCommandHandler(deps);
			const ctx = createMockContext("/tools list", "list");

			await handler(ctx);

			expect(deps.handleTools).toHaveBeenCalled();
		});

		it("routes 'mcp' to handleMcp", async () => {
			const { createToolsCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/tools-commands.js"
			);

			const deps = {
				handleTools: vi.fn(),
				handleMcp: vi.fn(),
				handleLsp: vi.fn(),
				handleWorkflow: vi.fn(),
				handleRun: vi.fn(),
				handleCommands: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createToolsCommandHandler(deps);
			const ctx = createMockContext("/tools mcp", "mcp");

			await handler(ctx);

			expect(deps.handleMcp).toHaveBeenCalled();
		});

		it("routes 'run' to handleRun", async () => {
			const { createToolsCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/tools-commands.js"
			);

			const deps = {
				handleTools: vi.fn(),
				handleMcp: vi.fn(),
				handleLsp: vi.fn(),
				handleWorkflow: vi.fn(),
				handleRun: vi.fn(),
				handleCommands: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createToolsCommandHandler(deps);
			const ctx = createMockContext("/tools run test", "run test");

			await handler(ctx);

			expect(deps.handleRun).toHaveBeenCalled();
		});

		it("treats unknown subcommand as script name for run", async () => {
			const { createToolsCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/tools-commands.js"
			);

			const deps = {
				handleTools: vi.fn(),
				handleMcp: vi.fn(),
				handleLsp: vi.fn(),
				handleWorkflow: vi.fn(),
				handleRun: vi.fn(),
				handleCommands: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createToolsCommandHandler(deps);
			const ctx = createMockContext("/tools test", "test");

			await handler(ctx);

			expect(deps.handleRun).toHaveBeenCalled();
		});
	});

	describe("Error Paths and Help", () => {
		it("shows help for unknown subcommand in session handler", async () => {
			const { createSessionCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleSessionInfo: vi.fn(),
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleTree: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				handleRecover: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/session unknowncmd", "unknowncmd");

			await handler(ctx);

			expect(ctx.showError).toHaveBeenCalledWith(
				"Unknown subcommand: unknowncmd",
			);
			expect(ctx.showInfo).toHaveBeenCalled();
		});

		it("shows help for --help flag in any handler", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn(),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn(),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag --help", "--help");

			await handler(ctx);

			expect(ctx.showInfo).toHaveBeenCalled();
			expect(deps.handleStatus).not.toHaveBeenCalled();
		});

		it("shows help for ? in any handler", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = {
				handleTheme: vi.fn(),
				handleClean: vi.fn(),
				handleFooter: vi.fn(),
				handleZen: vi.fn(),
				handleCompactTools: vi.fn(),
				showInfo: vi.fn(),
				getUiState: vi.fn().mockReturnValue({
					zenMode: false,
					cleanMode: "off",
					footerMode: "ensemble",
					compactTools: false,
				}),
			};

			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui ?", "?");

			handler(ctx);

			expect(ctx.showInfo).toHaveBeenCalled();
		});
	});

	describe("Alias Support", () => {
		it("cfg 'fw' routes to framework", async () => {
			const { createConfigCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/config-commands.js"
			);

			const deps = {
				handleConfig: vi.fn(),
				handleImport: vi.fn(),
				handleFramework: vi.fn(),
				handleComposer: vi.fn(),
				handleInit: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createConfigCommandHandler(deps);
			const ctx = createMockContext("/cfg fw react", "fw react");

			await handler(ctx);

			expect(deps.handleFramework).toHaveBeenCalled();
		});

		it("diag 'bg' routes to background", async () => {
			const { createDiagCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/diag-commands.js"
			);

			const deps = {
				handleStatus: vi.fn(),
				handleAbout: vi.fn(),
				handleContext: vi.fn(),
				handleStats: vi.fn(),
				handleBackground: vi.fn(),
				handleDiagnostics: vi.fn(),
				handleTelemetry: vi.fn(),
				handleTraining: vi.fn(),
				handleOtel: vi.fn(),
				handleConfig: vi.fn(),
				handleLsp: vi.fn(),
				handleMcp: vi.fn(),
				handleSources: vi.fn(),
				showInfo: vi.fn(),
				isDatabaseConfigured: vi.fn().mockReturnValue(false),
			};

			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag bg", "bg");

			await handler(ctx);

			expect(deps.handleBackground).toHaveBeenCalled();
		});

		it("ui 'dedup' routes to clean", async () => {
			const { createUiCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/ui-commands.js"
			);

			const deps = {
				handleTheme: vi.fn(),
				handleClean: vi.fn(),
				handleFooter: vi.fn(),
				handleZen: vi.fn(),
				handleCompactTools: vi.fn(),
				showInfo: vi.fn(),
				getUiState: vi.fn().mockReturnValue({
					zenMode: false,
					cleanMode: "off",
					footerMode: "ensemble",
					compactTools: false,
				}),
			};

			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui dedup soft", "dedup soft");

			handler(ctx);

			expect(deps.handleClean).toHaveBeenCalled();
		});

		it("safe 'guard' routes to guardian", async () => {
			const { createSafetyCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/safety-commands.js"
			);

			const deps = {
				handleApprovals: vi.fn(),
				handlePlanMode: vi.fn(),
				handleGuardian: vi.fn(),
				showInfo: vi.fn(),
				getSafetyState: vi.fn().mockReturnValue({
					approvalMode: "prompt",
					planMode: false,
					guardianEnabled: true,
				}),
			};

			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe guard run", "guard run");

			await handler(ctx);

			expect(deps.handleGuardian).toHaveBeenCalled();
		});

		it("git 'd' routes to diff", async () => {
			const { createGitCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/git-commands.js"
			);

			const deps = {
				handleDiff: vi.fn(),
				handleReview: vi.fn(),
				showInfo: vi.fn(),
				runGitCommand: vi.fn(),
			};

			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext("/git d src/index.ts", "d src/index.ts");

			await handler(ctx);

			expect(deps.handleDiff).toHaveBeenCalled();
		});

		it("usage 'spend' routes to cost", async () => {
			const { createUsageCommandHandler } = await import(
				"../../src/cli-tui/commands/grouped/usage-commands.js"
			);

			const deps = {
				handleCost: vi.fn(),
				handleQuota: vi.fn(),
				handleStats: vi.fn(),
			};

			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage spend", "spend");

			await handler(ctx);

			expect(deps.handleCost).toHaveBeenCalled();
		});
	});
});
