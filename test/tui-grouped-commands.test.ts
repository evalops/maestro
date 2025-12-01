import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandExecutionContext } from "../src/tui/commands/types.js";

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
	describe("SessionCommandHandler", () => {
		it("routes 'new' subcommand to handleNewChat", async () => {
			const { createSessionCommandHandler } = await import(
				"../src/tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss new", "new");

			await handler(ctx);

			expect(deps.handleNewChat).toHaveBeenCalled();
		});

		it("routes 'clear' subcommand to handleClear", async () => {
			const { createSessionCommandHandler } = await import(
				"../src/tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss clear", "clear");

			await handler(ctx);

			expect(deps.handleClear).toHaveBeenCalled();
		});

		it("routes 'list' subcommand to handleSessionsList", async () => {
			const { createSessionCommandHandler } = await import(
				"../src/tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss list", "list");

			await handler(ctx);

			expect(deps.handleSessionsList).toHaveBeenCalled();
		});

		it("defaults to 'info' when no subcommand provided", async () => {
			const { createSessionCommandHandler } = await import(
				"../src/tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
				showInfo: vi.fn(),
			};

			const handler = createSessionCommandHandler(deps);
			const ctx = createMockContext("/ss", "");

			await handler(ctx);

			expect(deps.handleSessionInfo).toHaveBeenCalled();
		});

		it("shows help on 'help' subcommand", async () => {
			const { createSessionCommandHandler } = await import(
				"../src/tui/commands/grouped/session-commands.js"
			);

			const deps = {
				handleNewChat: vi.fn(),
				handleClear: vi.fn(),
				handleSessionInfo: vi.fn(),
				handleSessionsList: vi.fn(),
				handleBranch: vi.fn(),
				handleQueue: vi.fn(),
				handleExport: vi.fn(),
				handleShare: vi.fn(),
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
			showInfo: vi.fn(),
			isDatabaseConfigured: vi.fn().mockReturnValue(false),
		});

		it("routes 'status' to handleStatus", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag status", "status");

			await handler(ctx);

			expect(deps.handleStatus).toHaveBeenCalled();
		});

		it("routes 'stats' to handleStats (not handleStatus)", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
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
				"../src/tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag telemetry", "telemetry");

			await handler(ctx);

			expect(deps.handleTelemetry).toHaveBeenCalled();
		});

		it("routes 'lsp' to handleLsp", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag lsp", "lsp");

			await handler(ctx);

			expect(deps.handleLsp).toHaveBeenCalled();
		});

		it("routes 'mcp' to handleMcp", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag mcp", "mcp");

			await handler(ctx);

			expect(deps.handleMcp).toHaveBeenCalled();
		});

		it("defaults to 'status' when no subcommand provided", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
			);

			const deps = createDiagDeps();
			const handler = createDiagCommandHandler(deps);
			const ctx = createMockContext("/diag", "");

			await handler(ctx);

			expect(deps.handleStatus).toHaveBeenCalled();
		});

		it("shows audit info when database not configured", async () => {
			const { createDiagCommandHandler } = await import(
				"../src/tui/commands/grouped/diag-commands.js"
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
				"../src/tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui theme", "theme");

			handler(ctx);

			expect(deps.handleTheme).toHaveBeenCalled();
		});

		it("routes 'zen' to handleZen", async () => {
			const { createUiCommandHandler } = await import(
				"../src/tui/commands/grouped/ui-commands.js"
			);

			const deps = createUiDeps();
			const handler = createUiCommandHandler(deps);
			const ctx = createMockContext("/ui zen on", "zen on");

			handler(ctx);

			expect(deps.handleZen).toHaveBeenCalled();
		});

		it("shows UI status when no subcommand provided", async () => {
			const { createUiCommandHandler } = await import(
				"../src/tui/commands/grouped/ui-commands.js"
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
				"../src/tui/commands/grouped/ui-commands.js"
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
				"../src/tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe approvals", "approvals");

			await handler(ctx);

			expect(deps.handleApprovals).toHaveBeenCalled();
		});

		it("routes 'plan' to handlePlanMode", async () => {
			const { createSafetyCommandHandler } = await import(
				"../src/tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe plan on", "plan on");

			await handler(ctx);

			expect(deps.handlePlanMode).toHaveBeenCalled();
		});

		it("routes 'guardian' to handleGuardian", async () => {
			const { createSafetyCommandHandler } = await import(
				"../src/tui/commands/grouped/safety-commands.js"
			);

			const deps = createSafetyDeps();
			const handler = createSafetyCommandHandler(deps);
			const ctx = createMockContext("/safe guardian", "guardian");

			await handler(ctx);

			expect(deps.handleGuardian).toHaveBeenCalled();
		});

		it("shows safety status when no subcommand provided", async () => {
			const { createSafetyCommandHandler } = await import(
				"../src/tui/commands/grouped/safety-commands.js"
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
				"../src/tui/commands/grouped/git-commands.js"
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
				"../src/tui/commands/grouped/git-commands.js"
			);

			const deps = createGitDeps();
			const handler = createGitCommandHandler(deps);
			const ctx = createMockContext("/git review", "review");

			await handler(ctx);

			expect(deps.handleReview).toHaveBeenCalled();
		});

		it("treats path-like argument as diff", async () => {
			const { createGitCommandHandler } = await import(
				"../src/tui/commands/grouped/git-commands.js"
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
				"../src/tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth login pro", "login pro");

			await handler(ctx);

			expect(deps.handleLogin).toHaveBeenCalled();
		});

		it("routes 'logout' to handleLogout", async () => {
			const { createAuthCommandHandler } = await import(
				"../src/tui/commands/grouped/auth-commands.js"
			);

			const deps = createAuthDeps();
			const handler = createAuthCommandHandler(deps);
			const ctx = createMockContext("/auth logout", "logout");

			await handler(ctx);

			expect(deps.handleLogout).toHaveBeenCalled();
		});

		it("shows authenticated status", async () => {
			const { createAuthCommandHandler } = await import(
				"../src/tui/commands/grouped/auth-commands.js"
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
				"../src/tui/commands/grouped/auth-commands.js"
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
				"../src/tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage cost", "cost");

			await handler(ctx);

			expect(deps.handleCost).toHaveBeenCalled();
		});

		it("routes 'quota' to handleQuota", async () => {
			const { createUsageCommandHandler } = await import(
				"../src/tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage quota", "quota");

			await handler(ctx);

			expect(deps.handleQuota).toHaveBeenCalled();
		});

		it("routes 'stats' to handleStats", async () => {
			const { createUsageCommandHandler } = await import(
				"../src/tui/commands/grouped/usage-commands.js"
			);

			const deps = createUsageDeps();
			const handler = createUsageCommandHandler(deps);
			const ctx = createMockContext("/usage stats", "stats");

			await handler(ctx);

			expect(deps.handleStats).toHaveBeenCalled();
		});

		it("defaults to stats on empty subcommand", async () => {
			const { createUsageCommandHandler } = await import(
				"../src/tui/commands/grouped/usage-commands.js"
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
				"../src/tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo", "");

			await handler(ctx);

			expect(deps.handleUndo).toHaveBeenCalled();
		});

		it("routes numeric argument to handleUndo", async () => {
			const { createUndoCommandHandler } = await import(
				"../src/tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo 3", "3");

			await handler(ctx);

			expect(deps.handleUndo).toHaveBeenCalled();
		});

		it("routes 'checkpoint' to handleCheckpoint", async () => {
			const { createUndoCommandHandler } = await import(
				"../src/tui/commands/grouped/undo-commands.js"
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
				"../src/tui/commands/grouped/undo-commands.js"
			);

			const deps = createUndoDeps();
			const handler = createUndoCommandHandler(deps);
			const ctx = createMockContext("/undo changes", "changes");

			await handler(ctx);

			expect(deps.handleChanges).toHaveBeenCalled();
		});

		it("shows history with checkpoint list", async () => {
			const { createUndoCommandHandler } = await import(
				"../src/tui/commands/grouped/undo-commands.js"
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
});
