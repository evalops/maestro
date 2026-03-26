/**
 * MiscHandlers — Manages terminal title, auto-retry events, external editor,
 * Ctrl+Z suspension, test verification results, and telemetry description.
 *
 * Owns state: terminalTitle.
 */

import { basename } from "node:path";
import type { TUI } from "@evalops/tui";
import type { AgentEvent } from "../../agent/types.js";
import type { TestResult } from "../../testing/index.js";
import { formatTestResult } from "../../testing/index.js";
import { createLogger } from "../../utils/logger.js";
import type { NotificationView } from "../notification-view.js";
import { openExternalEditor } from "../utils/external-editor.js";

const logger = createLogger("misc-handlers");

// ─── Dependency Interface ────────────────────────────────────────────────────

export interface MiscHandlerDeps {
	/** TUI instance for rendering. */
	ui: TUI;
	/** Notification view for toasts and errors (lazy — may not exist at construction time). */
	getNotificationView: () => NotificationView;
	/** Get editor text. */
	getEditorText: () => string;
	/** Set editor text. */
	setEditorText: (text: string) => void;
	/** Telemetry status object. */
	getTelemetryStatus: () => {
		enabled: boolean;
		runtimeOverride?: string | null;
		reason?: string;
		sampleRate: number;
	};
}

export interface MiscHandlerCallbacks {
	/** Set the agent running flag (used by auto-retry). */
	setAgentRunning: (running: boolean) => void;
	/** Refresh footer hints. */
	refreshFooterHint: () => void;
}

export interface MiscHandlerOptions {
	deps: MiscHandlerDeps;
	callbacks: MiscHandlerCallbacks;
}

// ─── Controller ──────────────────────────────────────────────────────────────

export class MiscHandlers {
	private readonly deps: MiscHandlerDeps;
	private readonly callbacks: MiscHandlerCallbacks;
	private terminalTitle: string | null = null;

	constructor(options: MiscHandlerOptions) {
		this.deps = options.deps;
		this.callbacks = options.callbacks;
	}

	/** Handle auto-retry events from the retry controller. */
	handleAutoRetryEvent(event: AgentEvent): void {
		if (event.type === "auto_retry_start") {
			const delaySec = (event.delayMs / 1000).toFixed(1);
			this.deps
				.getNotificationView()
				.showToast(
					`Retrying (attempt ${event.attempt}/${event.maxAttempts}) in ${delaySec}s... Press Escape to cancel.`,
					"warn",
				);
			this.callbacks.setAgentRunning(true);
			this.callbacks.refreshFooterHint();
		} else if (event.type === "auto_retry_end") {
			if (event.success) {
				this.deps
					.getNotificationView()
					.showToast(
						`Retry succeeded after ${event.attempt} attempt(s).`,
						"info",
					);
			} else if (event.finalError) {
				this.deps
					.getNotificationView()
					.showError(
						`Retry failed after ${event.attempt} attempt(s): ${event.finalError}`,
					);
			}
			this.callbacks.refreshFooterHint();
		}
	}

	/** Open the user's external editor with current editor text. */
	handleExternalEditor(): void {
		const result = openExternalEditor(this.deps.ui, this.deps.getEditorText());
		if (result.error) {
			this.deps.getNotificationView().showInfo(result.error);
			return;
		}
		if (typeof result.updatedText === "string") {
			this.deps.setEditorText(result.updatedText);
			this.deps.ui.requestRender();
		}
	}

	/** Handle Ctrl+Z suspension. */
	handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.deps
				.getNotificationView()
				.showInfo("Suspending is not supported on Windows terminals.");
			return;
		}
		process.once("SIGCONT", () => {
			this.deps.ui.start();
			this.deps.ui.requestRender("interactive");
		});
		this.deps.ui.stop();
		process.kill(0, "SIGTSTP");
	}

	/** Handle test verification result notification. */
	handleTestVerificationResult(result: TestResult): void {
		if (result.success) {
			this.deps
				.getNotificationView()
				.showInfo(
					`✓ Tests passed: ${result.passedTests}/${result.totalTests} (${result.durationMs}ms)`,
				);
		} else {
			const formatted = formatTestResult(result);
			this.deps.getNotificationView().showError(formatted);

			if (result.failures.length > 0) {
				const failureSummary = result.failures
					.slice(0, 3)
					.map((f) => `• ${f.testName}: ${f.errorMessage.split("\n")[0]}`)
					.join("\n");
				logger.warn("Test failures detected", {
					failedTests: result.failedTests,
					failures: failureSummary,
				});
			}
		}
	}

	/** Update the terminal title bar to show current directory. */
	updateTerminalTitle(): void {
		if (process.env.MAESTRO_DISABLE_TERMINAL_TITLE === "1") {
			return;
		}
		if (!process.stdout.isTTY) {
			return;
		}
		const dir = basename(process.cwd());
		const nextTitle = `maestro - ${dir}`;
		if (this.terminalTitle === nextTitle) {
			return;
		}
		process.stdout.write(`\u001b]0;${nextTitle}\u0007`);
		this.terminalTitle = nextTitle;
	}

	/** Clear the terminal title bar. */
	clearTerminalTitle(): void {
		if (!this.terminalTitle) {
			return;
		}
		if (process.env.MAESTRO_DISABLE_TERMINAL_TITLE === "1") {
			return;
		}
		if (!process.stdout.isTTY) {
			return;
		}
		process.stdout.write("\u001b]0;\u0007");
		this.terminalTitle = null;
	}

	/** Describe the current telemetry status as a string. */
	describeTelemetryStatus(): string {
		const status = this.deps.getTelemetryStatus();
		const base = status.enabled ? "enabled" : "disabled";
		const details: string[] = [];
		if (status.runtimeOverride) {
			details.push(`override=${status.runtimeOverride}`);
		} else if (status.reason) {
			details.push(status.reason);
		}
		if (status.sampleRate !== 1) {
			details.push(`sample=${status.sampleRate}`);
		}
		return details.length > 0 ? `${base} (${details.join(", ")})` : base;
	}
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createMiscHandlers(options: MiscHandlerOptions): MiscHandlers {
	return new MiscHandlers(options);
}
